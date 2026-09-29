import type {
  BlockRequest,
  BlockedItem,
  BlocklistResponse,
  DiscoverPreferences,
  DiscoverResponse,
  DiscoverSectionId,
  DiscoverStatus,
  FeedbackValue,
  Recommendation,
  ReleaseSummary,
  TagArtist,
} from '@offbeat/shared';
import { Cron } from 'croner';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { blocklist, feedback, recommendations, users } from '../db/schema.js';
import type { LastfmClient } from '../integrations/lastfm/client.js';
import type { LidarrClient, LidarrLookupArtist } from '../integrations/lidarr/client.js';
import type { ListenBrainzClient } from '../integrations/listenbrainz/client.js';
import type { MusicBrainzClient } from '../integrations/musicbrainz/client.js';
import { releaseType, yearOf } from '../catalog/releases.js';
import type { ImageUrls } from '../library/image-urls.js';
import type { Library } from '../library/library.js';
import {
  type Candidate,
  type DiscoveryMode,
  MODES,
  type Ranked,
  type Seed,
  type SimilarLists,
  VARIOUS_ARTISTS,
  buildSeeds,
  gather,
  normalizeName,
  rank,
  resolveCandidate,
  seededRandom,
} from './engine.js';
import { genreLabel, pickGenres } from './genres.js';
import { applyTaste, tagWeights } from './taste.js';
import { MAX_AGE, SourceCache } from './source-cache.js';

export interface DiscoveryOptions {
  /** Cron pattern for the daily refresh of every user, or null for none (tests). */
  schedule?: string | null;
  /** Recommendations kept per mode. */
  limit?: number;
  /** After feedback or a blocklist change, refresh this long after the last one (debounced). */
  feedbackRefreshMs?: number;
}

export interface DiscoverySources {
  lastfm: () => LastfmClient | null;
  listenbrainz: ListenBrainzClient;
  lidarr: () => LidarrClient | null;
  /** Curated genres when Last.fm is not connected. */
  musicbrainz: MusicBrainzClient;
}

/** What one computation used and produced, for storage and for reviewing quality. */
export interface Computed {
  seeds: Seed[];
  sources: { listenbrainz: boolean; lastfm: boolean };
  modes: Record<DiscoveryMode, Ranked[]>;
}

/** Deeper mode follows the similar artists of this many top first-hop picks. */
const SECOND_HOP_PARENTS = 12;
/** Name-only candidates (Last.fm without an MBID) resolved through Lidarr, best first. */
const RESOLVE_LIMIT = 120;
/**
 * Without Last.fm, genres come from MusicBrainz at one request per second, so
 * only this many per mode are looked up in a refresh (cached for later ones).
 */
const MUSICBRAINZ_GENRE_LIMIT = 30;
/** Albums to Start With: one per top pick, this many per mode. */
const STARTER_ALBUMS = 12;
/** A cached starter album (`start:<artist mbid>`). */
type StarterAlbum = { mbid: string; title: string; year: number | null };
/** An artist's most listened albums on ListenBrainz to check for a studio album. */
const STARTER_CANDIDATES = 5;
/** Explore by Tag: genres shown per mode. */
const TAGS_SHOWN = 10;
/** Artists shown on a tag page. */
const TAG_ARTISTS = 30;
/** Candidates whose popularity is looked up for Deeper. */
const POPULARITY_LIMIT = 400;

/**
 * Recommendations per user: seeds from the library and listening history,
 * similar artists from ListenBrainz (always) and Last.fm (when connected),
 * scored per mode by the engine, enriched with names, genres, and artwork
 * from Lidarr's artist lookup, and stored so Discover renders instantly.
 * Refreshed daily and on demand.
 */
export class Discovery {
  private readonly cache: SourceCache;
  private readonly running = new Map<number, Promise<void>>();
  private readonly errors = new Map<number, string>();
  /** Where each running refresh is, per user. */
  private readonly progress = new Map<number, NonNullable<DiscoverStatus['progress']>>();
  /** Pending refreshes after feedback, per user. */
  private readonly feedbackTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Candidate keys already checked by name in the current computation. */
  private verified = new Set<string>();
  private cron: Cron | null = null;

  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly sources: DiscoverySources,
    private readonly images: ImageUrls,
    private readonly log: FastifyBaseLogger,
    private readonly options: DiscoveryOptions = {},
  ) {
    this.cache = new SourceCache(db, log);
  }

  start() {
    const schedule = this.options.schedule === undefined ? '0 4 * * *' : this.options.schedule;
    if (schedule) this.cron = new Cron(schedule, { protect: true }, () => void this.refreshAll());
  }

  stop() {
    this.cron?.stop();
    this.cron = null;
    for (const timer of this.feedbackTimers.values()) clearTimeout(timer);
    this.feedbackTimers.clear();
  }

  isRefreshing(userId: number): boolean {
    return this.running.has(userId);
  }

  /** The refresh as Settings, Discovery shows it: whether one runs, how far along, and the next one. */
  status(userId: number): DiscoverStatus {
    const row = this.db
      .select({ generatedAt: recommendations.generatedAt })
      .from(recommendations)
      .where(eq(recommendations.userId, userId))
      .get();
    const next = this.cron?.nextRun();
    return {
      refreshing: this.isRefreshing(userId),
      progress: this.isRefreshing(userId) ? (this.progress.get(userId) ?? null) : null,
      generatedAt: row ? row.generatedAt.toISOString() : null,
      error: this.errors.get(userId) ?? null,
      nextRefreshAt: next ? next.toISOString() : null,
    };
  }

  /** The user's default mode and section layout, with anything missing filled in. */
  preferences(userId: number): DiscoverPreferences {
    const row = this.db.select({ prefs: users.discoverPrefs }).from(users).where(eq(users.id, userId)).get();
    let saved: Partial<DiscoverPreferences> = {};
    try {
      saved = JSON.parse(row?.prefs ?? '{}') as Partial<DiscoverPreferences>;
    } catch {
      // unreadable: the defaults
    }
    return normalizePreferences(saved);
  }

  savePreferences(userId: number, prefs: DiscoverPreferences): DiscoverPreferences {
    const clean = normalizePreferences(prefs);
    this.db.update(users).set({ discoverPrefs: JSON.stringify(clean) }).where(eq(users.id, userId)).run();
    return clean;
  }

  /** Starts a refresh for one user (or joins the one already running). */
  refresh(userId: number): Promise<void> {
    let run = this.running.get(userId);
    if (!run) {
      run = this.refreshNow(userId).finally(() => {
        this.running.delete(userId);
        this.progress.delete(userId);
      });
      this.running.set(userId, run);
    }
    return run;
  }

  async refreshAll() {
    for (const { id } of this.db.select({ id: users.id }).from(users).all()) {
      await this.refresh(id).catch(() => undefined);
    }
  }

  /** The stored recommendations for one mode, and whether a refresh is under way. */
  read(userId: number, mode: DiscoveryMode): DiscoverResponse {
    const row = this.db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.userId, userId), eq(recommendations.mode, mode)))
      .get();
    const stored = row ? (JSON.parse(row.payload) as StoredPayload) : null;
    const library = new Set(this.library.read().artists.map((a) => a.mbid));
    const ratings = new Map(
      this.db
        .select({ mbid: feedback.artistMbid, value: feedback.value })
        .from(feedback)
        .where(eq(feedback.userId, userId))
        .all()
        .map((r) => [r.mbid, (r.value > 0 ? 'up' : 'down') as FeedbackValue]),
    );
    // Feedback since the refresh is applied as the list is read, not written
    // into it, so clearing a thumbs down or unblocking brings a pick back at once.
    const blocked = this.db.select().from(blocklist).where(eq(blocklist.userId, userId)).all();
    const blockedArtists = new Set(blocked.filter((b) => b.kind === 'artist').map((b) => b.key));
    const blockedTags = new Set(blocked.filter((b) => b.kind === 'tag').map((b) => b.key));
    const hidden = (item: Recommendation) =>
      ratings.get(item.mbid) === 'down' || blockedArtists.has(item.mbid) || item.genres.some((g) => blockedTags.has(g.toLowerCase()));
    const kept = (stored?.items ?? []).filter((item) => !hidden(item));
    const gone = new Set((stored?.items ?? []).filter(hidden).map((i) => i.mbid));
    return {
      mode,
      generatedAt: row ? row.generatedAt.toISOString() : null,
      refreshing: this.isRefreshing(userId),
      error: this.errors.get(userId) ?? null,
      seedCount: stored?.seedCount ?? 0,
      sources: stored?.sources ?? { listenbrainz: true, lastfm: false },
      // Added since the refresh (a quick add): shown as in the library until the next one drops it.
      items: kept.map((item) => ({
        ...item,
        inLibrary: library.has(item.mbid),
        feedback: ratings.get(item.mbid) ?? null,
      })),
      albums: (stored?.albums ?? []).filter((a) => !gone.has(a.artistMbid)),
      albumsPending: stored?.albumsPending ?? false,
      tags: gone.size ? topTags(kept) : (stored?.tags ?? []),
      preferences: this.preferences(userId),
    };
  }

  /**
   * A tag page: artists MusicBrainz tags with this genre, the best known
   * first (ListenBrainz listeners), and the genres that go with it in the
   * user's own recommendations. Their albums come separately (tagAlbums).
   */
  async tag(userId: number, tag: string): Promise<{ artists: TagArtist[]; related: string[] }> {
    const ranked = await this.tagArtists(tag);
    const library = new Set(this.library.read().artists.map((a) => a.mbid));
    const recommended = new Set(MODES.flatMap((mode) => this.read(userId, mode).items.map((i) => i.mbid)));
    const artists = await Promise.all(
      ranked.map(async (a): Promise<TagArtist> => {
        const lookup = await this.lookup(a.mbid);
        return {
          mbid: a.mbid,
          name: lookup?.artistName ?? a.name,
          disambiguation: lookup?.disambiguation || a.disambiguation,
          imageUrl: this.images.remote(artistImage(lookup)),
          inLibrary: library.has(a.mbid),
          recommended: recommended.has(a.mbid),
        };
      }),
    );

    // Related: genres that appear alongside this one on the user's recommendations.
    const wanted = tag.toLowerCase();
    const counts = new Map<string, number>();
    for (const mode of MODES) {
      for (const item of this.read(userId, mode).items) {
        if (!item.genres.some((g) => g.toLowerCase() === wanted)) continue;
        for (const genre of item.genres) if (genre.toLowerCase() !== wanted) counts.set(genre, (counts.get(genre) ?? 0) + 1);
      }
    }
    const related = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g]) => g);
    return { artists, related };
  }

  /**
   * Top Albums for a tag page: the most played album of each of its best-known
   * artists. Uncached, this is one MusicBrainz request per artist (about a
   * second each), so the page loads it after the artists.
   */
  async tagAlbums(tag: string): Promise<ReleaseSummary[]> {
    const ranked = (await this.tagArtists(tag)).slice(0, STARTER_ALBUMS);
    const named = await Promise.all(ranked.map(async (a) => ({ mbid: a.mbid, name: (await this.lookup(a.mbid))?.artistName ?? a.name })));
    return this.starterAlbums(named);
  }

  /** Artists MusicBrainz tags with this genre, the best known first. */
  private async tagArtists(tag: string) {
    const found = await this.cache.get(`mb:tagged:${tag.toLowerCase()}`, MAX_AGE.similar, () =>
      this.sources.musicbrainz.artistsTagged(tag),
    );
    const listeners = await this.popularity(found.map((a) => a.mbid));
    return [...found]
      .filter((a) => a.mbid !== VARIOUS_ARTISTS)
      .sort((a, b) => (listeners.get(b.mbid) ?? 0) - (listeners.get(a.mbid) ?? 0))
      .slice(0, TAG_ARTISTS);
  }

  // Feedback and blocklist ----------------------------------------------------

  /**
   * Thumbs up or down on a pick (or null to clear). The artist's genres feed
   * the tag weights at the next refresh; a thumbs down also hides the artist
   * from the user's picks now (see read) and keeps it out.
   */
  rate(userId: number, mbid: string, value: FeedbackValue | null, name?: string) {
    if (value === null) {
      this.db.delete(feedback).where(and(eq(feedback.userId, userId), eq(feedback.artistMbid, mbid))).run();
    } else {
      const known = this.pickOf(userId, mbid);
      const genres = JSON.stringify(known?.genres ?? []);
      const label = name || known?.name || '';
      const vote = value === 'up' ? 1 : -1;
      this.db
        .insert(feedback)
        .values({ userId, artistMbid: mbid, name: label, value: vote, genres })
        .onConflictDoUpdate({
          target: [feedback.userId, feedback.artistMbid],
          set: { name: label, value: vote, genres, createdAt: new Date() },
        })
        .run();
    }
    this.refreshSoon(userId);
  }

  blocklist(userId: number): BlocklistResponse {
    const rows = this.db.select().from(blocklist).where(eq(blocklist.userId, userId)).all();
    const view = (r: (typeof rows)[number]): BlockedItem => ({
      id: r.id,
      kind: r.kind,
      key: r.key,
      name: r.name,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    });
    const newest = (a: BlockedItem, b: BlockedItem) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
    const hidden = this.db
      .select()
      .from(feedback)
      .where(and(eq(feedback.userId, userId), eq(feedback.value, -1)))
      .orderBy(desc(feedback.createdAt))
      .all()
      .map((r) => ({ mbid: r.artistMbid, name: r.name || r.artistMbid, createdAt: r.createdAt.toISOString() }));
    return {
      artists: rows.filter((r) => r.kind === 'artist').map(view).sort(newest),
      tags: rows.filter((r) => r.kind === 'tag').map(view).sort(newest),
      hidden,
    };
  }

  /** Blocks an artist or tag, which hides it from the user's picks now (see read). Blocking twice is fine. */
  block(userId: number, request: BlockRequest): BlockedItem {
    const key = request.kind === 'artist' ? request.mbid.toLowerCase() : request.name.trim().toLowerCase();
    const name = request.kind === 'artist' ? request.name : genreLabel(request.name);
    this.db
      .insert(blocklist)
      .values({ userId, kind: request.kind, key, name, source: request.source })
      .onConflictDoNothing()
      .run();
    this.refreshSoon(userId);
    return this.blocklist(userId)[request.kind === 'artist' ? 'artists' : 'tags'].find((b) => b.key === key)!;
  }

  /** Unblocks; picks it hid come back at once, and others can at the next refresh (started soon). */
  unblock(userId: number, id: number): boolean {
    const removed = this.db.delete(blocklist).where(and(eq(blocklist.userId, userId), eq(blocklist.id, id))).run().changes > 0;
    if (removed) this.refreshSoon(userId);
    return removed;
  }

  /** What the user's feedback means for a refresh. */
  private taste(userId: number) {
    const ratings = this.db.select().from(feedback).where(eq(feedback.userId, userId)).all();
    const blocked = this.db.select().from(blocklist).where(eq(blocklist.userId, userId)).all();
    return {
      weights: tagWeights(ratings.map((r) => ({ value: r.value, genres: JSON.parse(r.genres) as string[] }))),
      blockedTags: new Set(blocked.filter((b) => b.kind === 'tag').map((b) => b.key)),
      excluded: [
        ...blocked.filter((b) => b.kind === 'artist').map((b) => b.key),
        ...ratings.filter((r) => r.value < 0).map((r) => r.artistMbid),
      ],
    };
  }

  /** A recommended artist as stored, from whichever mode has it. */
  private pickOf(userId: number, mbid: string): Recommendation | undefined {
    for (const mode of MODES) {
      const item = this.stored(userId, mode)?.items.find((i) => i.mbid === mbid);
      if (item) return item;
    }
    return undefined;
  }

  /** Refresh a little after the last feedback, so several ratings in a row cost one refresh. */
  private refreshSoon(userId: number) {
    const delay = this.options.feedbackRefreshMs ?? 60_000;
    if (delay < 0) return;
    clearTimeout(this.feedbackTimers.get(userId));
    const timer = setTimeout(() => {
      this.feedbackTimers.delete(userId);
      void this.refresh(userId).catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.feedbackTimers.set(userId, timer);
  }

  private stored(userId: number, mode: DiscoveryMode): StoredPayload | null {
    const row = this.db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.userId, userId), eq(recommendations.mode, mode)))
      .get();
    return row ? (JSON.parse(row.payload) as StoredPayload) : null;
  }

  /** Saves every mode at once, so the modes never disagree about when they were made. */
  private store(userId: number, generatedAt: Date, payloadFor: (mode: DiscoveryMode) => StoredPayload) {
    const payloads = new Map(MODES.map((mode) => [mode, JSON.stringify(payloadFor(mode))]));
    this.db.transaction((tx) => {
      for (const mode of MODES) {
        const payload = payloads.get(mode)!;
        tx.insert(recommendations)
          .values({ userId, mode, payload, generatedAt })
          .onConflictDoUpdate({ target: [recommendations.userId, recommendations.mode], set: { payload, generatedAt } })
          .run();
      }
    });
  }

  private async refreshNow(userId: number) {
    const started = Date.now();
    const step = (n: number, label: string) => this.progress.set(userId, { step: n, steps: REFRESH_STEPS, label });
    try {
      step(1, 'Reading your library and listening');
      const seeds = await this.seedsFor(userId);
      const taste = this.taste(userId);
      step(2, 'Finding similar artists');
      const computed = await this.compute(seeds, { random: seededRandom(started ^ userId), exclude: taste.excluded });
      step(3, 'Getting artist details');
      const enriched = await this.enrich(computed);
      const items = {} as Record<DiscoveryMode, Recommendation[]>;
      for (const mode of MODES) items[mode] = applyTaste(enriched[mode], taste.weights, taste.blockedTags);
      const generatedAt = new Date();
      const base = (mode: DiscoveryMode) => ({
        items: items[mode],
        tags: topTags(items[mode]),
        seedCount: computed.seeds.length,
        sources: computed.sources,
      });

      // Top Picks first: albums take a minute on a first refresh (MusicBrainz, one
      // request per second). Until they are ready, keep the previous refresh's
      // albums, or mark them pending when there are none yet.
      this.store(
        userId,
        generatedAt,
        (mode) => {
          const previous = this.stored(userId, mode)?.albums ?? [];
          return { ...base(mode), albums: previous, albumsPending: previous.length === 0 };
        },
      );
      step(4, 'Finding albums to start with');
      const albums = {} as Record<DiscoveryMode, ReleaseSummary[]>;
      for (const mode of MODES) albums[mode] = await this.starterAlbums(items[mode].slice(0, STARTER_ALBUMS));
      this.store(userId, generatedAt, (mode) => ({ ...base(mode), albums: albums[mode], albumsPending: false }));
      this.errors.delete(userId);
      this.log.info(
        { userId, seeds: computed.seeds.length, ms: Date.now() - started, lastfm: computed.sources.lastfm },
        'Recommendations refreshed',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not refresh recommendations';
      this.errors.set(userId, message);
      this.log.warn({ err: error, userId }, 'Recommendation refresh failed');
      throw error;
    }
  }

  /** Library artists, weighted by the user's ListenBrainz and Last.fm plays when they have added usernames. */
  async seedsFor(userId: number): Promise<Seed[]> {
    const user = this.db.select().from(users).where(eq(users.id, userId)).get();
    const library = this.library.read().artists.map((a) => ({ mbid: a.mbid, name: a.name }));
    const listened: { mbid: string | null; name: string; plays: number }[] = [];
    if (user?.listenbrainzUsername) {
      const name = user.listenbrainzUsername;
      listened.push(
        ...(await this.cache
          .get(`lb:top:${name}`, MAX_AGE.listening, () => this.sources.listenbrainz.userTopArtists(name))
          .catch(() => [])),
      );
    }
    const lastfm = this.sources.lastfm();
    if (user?.lastfmUsername && lastfm) {
      const name = user.lastfmUsername;
      listened.push(
        ...(await this.cache.get(`lf:top:${name}`, MAX_AGE.listening, () => lastfm.userTopArtists(name)).catch(() => [])),
      );
    }
    // Played artists Last.fm gave no MBID for: resolve by name so they can seed too.
    for (const artist of listened) {
      if (!artist.mbid) artist.mbid = (await this.resolveName(artist.name))?.foreignArtistId ?? null;
    }
    return buildSeeds(library, listened);
  }

  /**
   * The engine run for a set of seeds, without storing anything. Also used to
   * review recommendation quality with chosen seeds or sources.
   */
  async compute(
    seeds: Seed[],
    {
      random = Math.random,
      useLastfm = true,
      limit = this.options.limit ?? 50,
      exclude: excluded = [] as Iterable<string>,
    } = {},
  ): Promise<Computed> {
    this.verified = new Set();
    const lastfm = useLastfm ? this.sources.lastfm() : null;
    const pool = new Map<string, Candidate>();
    const firstHop = await Promise.all(seeds.map(async (seed) => ({ seed, lists: await this.similar(seed, lastfm) })));
    // Popularity first: ListenBrainz scores are corrected with it.
    const listeners = await this.popularity(listenBrainzMbids(firstHop.map((h) => h.lists)));
    gather(pool, firstHop, listeners);
    await this.verifyNames(pool);

    const exclude = new Set([
      ...this.library.read().artists.map((a) => a.mbid),
      ...seeds.map((s) => s.mbid),
      ...excluded,
      VARIOUS_ARTISTS,
    ]);
    const excludeNames = new Set(this.library.read().artists.map((a) => normalizeName(a.name)));

    // Deeper: follow the similar artists of its own first-hop picks (popularity already penalized),
    // so the second hop leads away from the artists everyone plays rather than back to them.
    const parents = rank(pool.values(), 'deeper', { exclude, excludeNames, listeners, variety: 0, limit: SECOND_HOP_PARENTS });
    const hops = await Promise.all(
      parents.map(async (parent) => {
        const seed = seeds.find((s) => s.mbid === parent.reason.seedMbid) ?? seeds[0]!;
        const lists = await this.similar({ mbid: parent.mbid, name: parent.name }, lastfm);
        return { seed, lists, via: { mbid: parent.mbid, name: parent.name }, discount: 0.5 * (parent.score / 100) };
      }),
    );
    for (const [mbid, count] of await this.popularity(listenBrainzMbids(hops.map((h) => h.lists)))) listeners.set(mbid, count);
    gather(pool, hops, listeners);
    await this.verifyNames(pool);

    // Popularity for the rest (Last.fm-only candidates), for Deeper's penalty.
    const unknown = [...pool.values()]
      .filter((c) => c.mbid && !listeners.has(c.mbid))
      .sort((a, b) => strength(b) - strength(a));
    for (const [mbid, count] of await this.popularity(unknown.slice(0, POPULARITY_LIMIT).map((c) => c.mbid!))) {
      listeners.set(mbid, count);
    }

    const modes = {} as Record<DiscoveryMode, Ranked[]>;
    for (const mode of MODES) modes[mode] = rank(pool.values(), mode, { exclude, excludeNames, listeners, random, limit });
    return { seeds, sources: { listenbrainz: true, lastfm: !!lastfm }, modes };
  }

  /**
   * Last.fm names need care: some come without an MBID, and some MBIDs point
   * at a different artist of the same name (there are several bands called
   * Face to Face). A Last.fm suggestion ListenBrainz does not corroborate is
   * checked by name through Lidarr's lookup, and the first exact match wins,
   * since Lidarr ranks the best-known artist first. Strongest first, bounded.
   */
  private async verifyNames(pool: Map<string, Candidate>) {
    const unverified = [...pool.values()]
      .filter((c) => !c.sources.has('listenbrainz') && !this.verified.has(c.key))
      .sort((a, b) => strength(b) - strength(a))
      .slice(0, RESOLVE_LIMIT);
    await Promise.all(
      unverified.map(async (c) => {
        const found = await this.resolveName(c.name);
        this.verified.add(found?.foreignArtistId ?? c.key);
        if (found) resolveCandidate(pool, c.key, found.foreignArtistId, found.artistName);
      }),
    );
  }

  /** Names, genres, and artwork from Lidarr's artist lookup (Last.fm has no real artist images). */
  async enrich(computed: Computed): Promise<Record<DiscoveryMode, Recommendation[]>> {
    const mbids = new Set(MODES.flatMap((mode) => computed.modes[mode].map((r) => r.mbid)));
    const lookups = new Map<string, LidarrLookupArtist | null>();
    await Promise.all([...mbids].map(async (mbid) => lookups.set(mbid, await this.lookup(mbid))));
    const genres = await this.genres(computed, lookups);
    const result = {} as Record<DiscoveryMode, Recommendation[]>;
    for (const mode of MODES) {
      result[mode] = computed.modes[mode].map((r) => {
        const artist = lookups.get(r.mbid) ?? null;
        const image = artistImage(artist);
        return {
          mbid: r.mbid,
          name: artist?.artistName ?? r.name,
          disambiguation: artist?.disambiguation || null,
          genres: genres.get(r.mbid) ?? [],
          imageUrl: this.images.remote(image),
          score: r.score,
          reason: r.reason,
          seeds: r.seeds,
          sources: r.sources,
          listeners: r.listeners,
        };
      });
    }
    return result;
  }

  /**
   * Genres per recommendation: Last.fm's tags when connected (filtered to real
   * genres), otherwise MusicBrainz's curated genres. Not Lidarr's free-form
   * tags, which include things that are not genres at all.
   */
  private async genres(computed: Computed, lookups: Map<string, LidarrLookupArtist | null>): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const nameOf = (mbid: string, fallback: string) => lookups.get(mbid)?.artistName ?? fallback;
    const lastfm = computed.sources.lastfm ? this.sources.lastfm() : null;
    if (lastfm) {
      const all = new Map(MODES.flatMap((mode) => computed.modes[mode].map((r) => [r.mbid, r.name] as const)));
      await Promise.all(
        [...all].map(async ([mbid, name]) => {
          const artist = { mbid, name: nameOf(mbid, name) };
          const tags = await this.cache
            .get(`lf:tags:${mbid}`, MAX_AGE.lookup, () => lastfm.artistTopTags(artist))
            .catch(() => []);
          result.set(mbid, pickGenres(tags, { artistName: artist.name, source: 'lastfm' }));
        }),
      );
      return result;
    }
    const wanted = new Map(
      MODES.flatMap((mode) => computed.modes[mode].slice(0, MUSICBRAINZ_GENRE_LIMIT).map((r) => [r.mbid, r.name] as const)),
    );
    for (const [mbid, name] of wanted) {
      const found = await this.sources.musicbrainz.artistGenres(mbid).catch(() => []);
      result.set(mbid, pickGenres(found, { artistName: nameOf(mbid, name), source: 'musicbrainz' }));
    }
    return result;
  }

  /**
   * Each artist's most played album (ListenBrainz listeners) among its
   * studio albums on MusicBrainz, one per artist, in the artists' order.
   */
  private async starterAlbums(artists: { mbid: string; name: string }[]): Promise<ReleaseSummary[]> {
    const uncached = artists.filter((a) => this.cache.peek(`start:${a.mbid}`, MAX_AGE.similar) === undefined);
    const quick = await this.quickStarterAlbums(uncached);
    const found = await Promise.all(artists.map((artist) => this.starterAlbum(artist, quick)));
    return artists.flatMap((artist, i): ReleaseSummary[] => {
      const album = found[i];
      if (!album) return [];
      return [
        {
          mbid: album.mbid,
          title: album.title,
          type: 'Album',
          year: album.year,
          coverUrl: this.images.releaseGroupCover(album.mbid),
          artistMbid: artist.mbid,
          artistName: artist.name,
          status: { kind: 'available' },
        },
      ];
    });
  }

  /**
   * Starter albums the fast way: each artist's most listened albums on
   * ListenBrainz (all artists at once), then one MusicBrainz search for their
   * types, so live albums and compilations are skipped. Browsing each artist
   * on MusicBrainz instead takes a second or more per artist. Artists this
   * cannot settle are left out, and starterAlbum browses for them.
   */
  private async quickStarterAlbums(artists: { mbid: string }[]): Promise<Map<string, StarterAlbum>> {
    const result = new Map<string, StarterAlbum>();
    if (!artists.length) return result;
    const candidates = await Promise.all(
      artists.map((artist) =>
        this.sources.listenbrainz
          .topReleaseGroups(artist.mbid)
          .then((groups) => groups.filter((g) => g.type === 'Album').slice(0, STARTER_CANDIDATES).map((g) => g.mbid))
          .catch(() => [] as string[]),
      ),
    );
    if (!candidates.some((c) => c.length)) return result;
    const groups = await this.sources.musicbrainz.releaseGroupsById(candidates.flat()).catch(() => []);
    const byId = new Map(groups.map((g) => [g.id, g]));
    artists.forEach((artist, i) => {
      const best = candidates[i]!
        .map((mbid) => byId.get(mbid))
        .find((g) => g && releaseType(g['primary-type'], g['secondary-types']) === 'Album' && g['first-release-date']);
      if (best) result.set(artist.mbid, { mbid: best.id, title: best.title, year: yearOf(best['first-release-date']) });
    });
    return result;
  }

  /** One artist's starter album: from quickStarterAlbums, or by browsing MusicBrainz. */
  private starterAlbum(artist: { mbid: string }, quick: Map<string, StarterAlbum>) {
    return this.cache
      .get(`start:${artist.mbid}`, MAX_AGE.similar, async (): Promise<StarterAlbum | null> => {
        const known = quick.get(artist.mbid);
        if (known) return known;
        const groups = (await this.sources.musicbrainz.releaseGroups(artist.mbid, { albumsOnly: true })).filter(
          (g) => releaseType(g['primary-type'], g['secondary-types']) === 'Album' && g['first-release-date'],
        );
        if (!groups.length) return null;
        const listeners = await this.sources.listenbrainz
          .releaseGroupPopularity(groups.map((g) => g.id))
          .catch(() => new Map<string, number>());
        const best = [...groups].sort(
          (a, b) =>
            (listeners.get(b.id) ?? 0) - (listeners.get(a.id) ?? 0) ||
            (a['first-release-date'] ?? '').localeCompare(b['first-release-date'] ?? ''),
        )[0]!;
        return { mbid: best.id, title: best.title, year: yearOf(best['first-release-date']) };
      })
      .catch(() => null);
  }

  private async similar(artist: { mbid: string; name: string }, lastfm: LastfmClient | null): Promise<SimilarLists> {
    const [listenbrainz, fromLastfm] = await Promise.all([
      this.cache
        .get(`lb:similar:${artist.mbid}`, MAX_AGE.similar, () => this.sources.listenbrainz.similarArtists(artist.mbid))
        .catch((error: unknown) => {
          this.log.warn({ err: error, mbid: artist.mbid }, 'ListenBrainz similar artists unavailable');
          return null;
        }),
      lastfm
        ? this.cache
            .get(`lf:similar:${artist.mbid}`, MAX_AGE.similar, () => lastfm.similarArtists(artist))
            .catch((error: unknown) => {
              this.log.warn({ err: error, mbid: artist.mbid }, 'Last.fm similar artists unavailable');
              return null;
            })
        : Promise.resolve(null),
    ]);
    return { listenbrainz, lastfm: fromLastfm };
  }

  /** ListenBrainz listener counts, cached per artist and fetched in batches. Unknown artists are left out. */
  private async popularity(mbids: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const missing: string[] = [];
    for (const mbid of mbids) {
      const hit = this.cache.peek<number | null>(`lb:pop:${mbid}`, MAX_AGE.popularity);
      if (hit === undefined) missing.push(mbid);
      else if (hit !== null) result.set(mbid, hit);
    }
    if (missing.length) {
      try {
        const fetched = await this.sources.listenbrainz.popularity(missing);
        for (const mbid of missing) {
          const listeners = fetched.get(mbid) ?? null;
          this.cache.put(`lb:pop:${mbid}`, listeners);
          if (listeners !== null) result.set(mbid, listeners);
        }
      } catch (error) {
        this.log.warn({ err: error }, 'ListenBrainz popularity unavailable; Deeper ranks without it');
      }
    }
    return result;
  }

  /** Lidarr's lookup for an artist by MBID: canonical name, disambiguation, genres, artwork. */
  private lookup(mbid: string): Promise<LidarrLookupArtist | null> {
    const lidarr = this.sources.lidarr();
    if (!lidarr) return Promise.resolve(null);
    return this.cache
      .get(`lidarr:artist:${mbid}`, MAX_AGE.lookup, async () => (await lidarr.lookupArtists(`lidarr:${mbid}`))[0] ?? null)
      .catch(() => null);
  }

  /**
   * An artist's MBID from its name, through Lidarr's lookup: only an exact
   * match (ignoring case, accents, and "The") counts, first in Lidarr's
   * relevance order, so an unrelated artist is never picked on similarity.
   */
  private resolveName(name: string): Promise<LidarrLookupArtist | null> {
    const lidarr = this.sources.lidarr();
    if (!lidarr) return Promise.resolve(null);
    const wanted = normalizeName(name);
    return this.cache
      .get(`lidarr:name:${wanted}`, MAX_AGE.lookup, async () => {
        const results = await lidarr.lookupArtists(name);
        return results.find((a) => normalizeName(a.artistName) === wanted) ?? null;
      })
      .catch(() => null);
  }
}

/** What a refresh stores per user and mode. */
interface StoredPayload {
  items: Recommendation[];
  albums: ReleaseSummary[];
  /** Albums to Start With are still being found (first refresh only). */
  albumsPending?: boolean;
  tags: string[];
  seedCount: number;
  sources: { listenbrainz: boolean; lastfm: boolean };
}

/** An artist's picture from Lidarr's lookup: the poster, else the fanart. */
function artistImage(artist: LidarrLookupArtist | null | undefined): string | null {
  const image = artist?.images?.find((i) => i.coverType === 'poster') ?? artist?.images?.find((i) => i.coverType === 'fanart');
  return image?.remoteUrl ?? null;
}

/** Explore by Tag: genres across the recommendations, weighted by each pick's score. */
/** Steps a refresh reports (see refreshNow). */
const REFRESH_STEPS = 4;
const SECTION_IDS: DiscoverSectionId[] = ['picks', 'albums', 'tags'];

/** Every known section exactly once, in the saved order, new ones added (visible) at the end. */
export function normalizePreferences(saved: Partial<DiscoverPreferences>): DiscoverPreferences {
  const defaultMode = MODES.includes(saved.defaultMode as DiscoveryMode) ? (saved.defaultMode as DiscoveryMode) : 'balanced';
  const seen = new Set<DiscoverSectionId>();
  const sections: DiscoverPreferences['sections'] = [];
  for (const section of Array.isArray(saved.sections) ? saved.sections : []) {
    if (!SECTION_IDS.includes(section?.id) || seen.has(section.id)) continue;
    seen.add(section.id);
    sections.push({ id: section.id, visible: section.visible !== false });
  }
  for (const id of SECTION_IDS) if (!seen.has(id)) sections.push({ id, visible: true });
  return { defaultMode, sections };
}

function topTags(items: Recommendation[]): string[] {
  const weights = new Map<string, number>();
  for (const item of items) for (const genre of item.genres) weights.set(genre, (weights.get(genre) ?? 0) + item.score);
  return [...weights].sort((a, b) => b[1] - a[1]).slice(0, TAGS_SHOWN).map(([genre]) => genre);
}

/** Every artist the ListenBrainz lists mention. */
function listenBrainzMbids(lists: SimilarLists[]): string[] {
  return [...new Set(lists.flatMap((l) => (l.listenbrainz ?? []).map((a) => a.mbid)))];
}

/** How strongly a candidate is recommended overall, ignoring mode: for deciding what to look up first. */
function strength(candidate: Candidate): number {
  return candidate.contributions.reduce((total, c) => total + c.match * c.seed.weight, 0);
}
