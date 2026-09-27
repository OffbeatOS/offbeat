import type { DiscoverResponse, Recommendation } from '@offbeat/shared';
import { Cron } from 'croner';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { recommendations, users } from '../db/schema.js';
import type { LastfmClient } from '../integrations/lastfm/client.js';
import type { LidarrClient, LidarrLookupArtist } from '../integrations/lidarr/client.js';
import type { ListenBrainzClient } from '../integrations/listenbrainz/client.js';
import type { MusicBrainzClient } from '../integrations/musicbrainz/client.js';
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
import { pickGenres } from './genres.js';
import { MAX_AGE, SourceCache } from './source-cache.js';

export interface DiscoveryOptions {
  /** Cron pattern for the daily refresh of every user, or null for none (tests). */
  schedule?: string | null;
  /** Recommendations kept per mode. */
  limit?: number;
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
  }

  isRefreshing(userId: number): boolean {
    return this.running.has(userId);
  }

  /** Starts a refresh for one user (or joins the one already running). */
  refresh(userId: number): Promise<void> {
    let run = this.running.get(userId);
    if (!run) {
      run = this.refreshNow(userId).finally(() => this.running.delete(userId));
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
    const stored = row ? (JSON.parse(row.payload) as Pick<DiscoverResponse, 'items' | 'seedCount' | 'sources'>) : null;
    return {
      mode,
      generatedAt: row ? row.generatedAt.toISOString() : null,
      refreshing: this.isRefreshing(userId),
      error: this.errors.get(userId) ?? null,
      seedCount: stored?.seedCount ?? 0,
      sources: stored?.sources ?? { listenbrainz: true, lastfm: false },
      items: stored?.items ?? [],
    };
  }

  private async refreshNow(userId: number) {
    const started = Date.now();
    try {
      const seeds = await this.seedsFor(userId);
      const computed = await this.compute(seeds, { random: seededRandom(started ^ userId) });
      const items = await this.enrich(computed);
      const generatedAt = new Date();
      this.db.transaction((tx) => {
        for (const mode of MODES) {
          const payload = JSON.stringify({
            items: items[mode],
            seedCount: computed.seeds.length,
            sources: computed.sources,
          });
          tx.insert(recommendations)
            .values({ userId, mode, payload, generatedAt })
            .onConflictDoUpdate({
              target: [recommendations.userId, recommendations.mode],
              set: { payload, generatedAt },
            })
            .run();
        }
      });
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
    { random = Math.random, useLastfm = true, limit = this.options.limit ?? 50 } = {},
  ): Promise<Computed> {
    this.verified = new Set();
    const lastfm = useLastfm ? this.sources.lastfm() : null;
    const pool = new Map<string, Candidate>();
    const firstHop = await Promise.all(seeds.map(async (seed) => ({ seed, lists: await this.similar(seed, lastfm) })));
    // Popularity first: ListenBrainz scores are corrected with it.
    const listeners = await this.popularity(listenBrainzMbids(firstHop.map((h) => h.lists)));
    gather(pool, firstHop, listeners);
    await this.verifyNames(pool);

    const exclude = new Set([...this.library.read().artists.map((a) => a.mbid), ...seeds.map((s) => s.mbid), VARIOUS_ARTISTS]);
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
        const image = artist?.images?.find((i) => i.coverType === 'poster') ?? artist?.images?.find((i) => i.coverType === 'fanart');
        return {
          mbid: r.mbid,
          name: artist?.artistName ?? r.name,
          disambiguation: artist?.disambiguation || null,
          genres: genres.get(r.mbid) ?? [],
          imageUrl: this.images.remote(image?.remoteUrl),
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

/** Every artist the ListenBrainz lists mention. */
function listenBrainzMbids(lists: SimilarLists[]): string[] {
  return [...new Set(lists.flatMap((l) => (l.listenbrainz ?? []).map((a) => a.mbid)))];
}

/** How strongly a candidate is recommended overall, ignoring mode: for deciding what to look up first. */
function strength(candidate: Candidate): number {
  return candidate.contributions.reduce((total, c) => total + c.match * c.seed.weight, 0);
}
