import type {
  AlbumDetail,
  ArtistDetail,
  ArtistSummary,
  ReleaseSummary,
  SearchResponse,
  SearchTop,
  Track,
} from '@offbeat/shared';
import type { FastifyBaseLogger } from 'fastify';
import { HttpError } from '../api/errors.js';
import type { Db } from '../db/index.js';
import { requests } from '../db/schema.js';
import {
  type LidarrAlbum,
  type LidarrClient,
  type LidarrLookupAlbum,
  type LidarrLookupArtist,
  LidarrRejected,
} from '../integrations/lidarr/client.js';
import { type StoredLidarr, clientFor, loadLidarr } from '../integrations/lidarr/settings.js';
import type { MbReleaseGroup, MusicBrainzClient } from '../integrations/musicbrainz/client.js';
import type { ImageUrls } from '../library/image-urls.js';
import type { Library } from '../library/library.js';
import type { SettingsStore } from '../settings/store.js';
import { SHOWN_TYPES, albumTrackTotal, lidarrStatus, normalize, releaseType, yearOf } from './releases.js';

const LOOKUP_TTL_MS = 10 * 60 * 1000;
const ALBUMS_TTL_MS = 60 * 1000;
/** How long an album add waits for Lidarr to load a newly added artist's albums. */
const ALBUM_APPEAR_TIMEOUT_MS = 60_000;

export interface CatalogOptions {
  /** Poll interval while waiting for Lidarr to load a new artist's albums. */
  pollMs?: number;
  albumAppearTimeoutMs?: number;
  timeoutMs?: number;
}

/**
 * Artists and albums whether or not they are in Lidarr, keyed by MusicBrainz
 * id so the same page works before and after adding. Library artists come
 * from Lidarr (with file status); everything else from Lidarr's metadata
 * lookup and MusicBrainz.
 */
export class Catalog {
  private readonly lookups = new Map<string, { at: number; value: Promise<unknown> }>();
  private readonly albumCache = new Map<number, { at: number; value: Promise<LidarrAlbum[]> }>();
  /** One add at a time per MBID, so double clicks never create duplicates. */
  private readonly adding = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly library: Library,
    private readonly musicbrainz: MusicBrainzClient,
    private readonly images: ImageUrls,
    private readonly log: FastifyBaseLogger,
    private readonly options: CatalogOptions = {},
  ) {}

  // Search -------------------------------------------------------------------

  async search(query: string): Promise<SearchResponse> {
    const client = this.client();
    const [artistResults, albumResults] = await Promise.all([
      this.cachedLookup(`artist:${query}`, () => client.lookupArtists(query)),
      this.cachedLookup(`album:${query}`, () => client.lookupAlbums(query)),
    ]);

    const wanted = normalize(query);
    const seen = new Set<string>();
    const artists = artistResults
      .filter((a) => a.foreignArtistId && !seen.has(a.foreignArtistId) && seen.add(a.foreignArtistId))
      .map((a) => this.lookupArtistSummary(a))
      // Exact name matches first, otherwise Lidarr's relevance order.
      .sort((a, b) => Number(normalize(b.name) === wanted) - Number(normalize(a.name) === wanted));

    const exactArtist = artists.find((a) => normalize(a.name) === wanted);
    const exactAlbum = albumResults.find((a) => normalize(a.title) === wanted);

    let top: SearchTop | null = null;
    let albums: ReleaseSummary[] = [];
    if (exactArtist || (!exactAlbum && artists[0])) {
      const artist = (exactArtist ?? artists[0])!;
      const discography = await this.discography(artist.mbid, artist.name).catch((error: unknown) => {
        this.log.warn({ err: error }, 'Discography unavailable for search');
        return [] as ReleaseSummary[];
      });
      const shown = discography.filter((r) => SHOWN_TYPES.has(r.type));
      top = {
        kind: 'artist',
        artist,
        albumCount: shown.length || null,
        albumsInLibrary: artist.inLibrary ? shown.filter((r) => r.status.kind === 'in-library').length : null,
      };
      albums = shown.filter((r) => r.type === 'Album').slice(0, 6);
    } else if (albumResults.length) {
      albums = await Promise.all(albumResults.slice(0, 8).map((a) => this.lookupAlbumSummary(a)));
      top = { kind: 'album', album: albums[0]! };
    }

    const topMbid = top?.kind === 'artist' ? top.artist.mbid : null;
    return {
      query,
      top,
      albums,
      artists: artists.filter((a) => a.mbid !== topMbid).slice(0, 12),
    };
  }

  // Artist and album pages ---------------------------------------------------

  async artist(mbid: string): Promise<ArtistDetail> {
    const client = this.client();
    const row = this.library.byMbid(mbid);
    const lookup = await this.lookupByMbid(mbid);
    if (!row && !lookup) throw new HttpError(404, 'No artist with that MusicBrainz id');

    let overview = lookup?.overview ?? null;
    let monitored: boolean | null = null;
    if (row) {
      const fresh = await client.artist(row.lidarrId);
      this.library.upsert(fresh);
      overview = fresh.overview || overview;
      monitored = fresh.monitored;
    }
    const summary = row ? this.libraryArtistSummary(mbid, lookup) : this.lookupArtistSummary(lookup!);
    return {
      ...summary,
      overview: overview || null,
      bannerUrl: this.images.remote(remoteImage(lookup, 'fanart')),
      monitored,
      releases: (await this.discography(mbid, summary.name)).filter(
        (r) => SHOWN_TYPES.has(r.type) || r.status.kind === 'in-library' || r.status.kind === 'partial',
      ),
    };
  }

  async album(releaseGroupMbid: string): Promise<AlbumDetail> {
    const group = await this.musicbrainz.releaseGroup(releaseGroupMbid);
    const credit = group['artist-credit']?.[0]?.artist;
    if (!credit) throw new HttpError(404, 'That release has no artist on MusicBrainz');
    const row = this.library.byMbid(credit.id);
    const artistName = row?.name ?? credit.name;

    // "More by": the rest of the artist's shown releases, newest first.
    const more = async () =>
      (await this.discography(credit.id, artistName).catch(() => [] as ReleaseSummary[]))
        .filter((r) => r.mbid !== releaseGroupMbid && SHOWN_TYPES.has(r.type))
        .slice(0, 6);
    const genres = row
      ? (JSON.parse(row.genres) as string[]).slice(0, 2)
      : ((await this.lookupByMbid(credit.id).catch(() => null))?.genres ?? []).slice(0, 2);

    const album = row ? await this.findLidarrAlbum(row.lidarrId, releaseGroupMbid) : undefined;
    if (album) {
      const tracks = await this.client().tracks(album.id);
      return {
        ...this.lidarrAlbumSummary(album, credit.id, artistName),
        artistInLibrary: true,
        monitored: album.monitored,
        trackFileCount: album.statistics?.trackFileCount ?? 0,
        trackCount: albumTrackTotal(album) || tracks.length,
        genres,
        tracks: tracks
          .sort(
            (a, b) =>
              (a.mediumNumber ?? 1) - (b.mediumNumber ?? 1) || (a.absoluteTrackNumber ?? 0) - (b.absoluteTrackNumber ?? 0),
          )
          .map(
            (t): Track => ({
              position: t.trackNumber || String(t.absoluteTrackNumber ?? ''),
              title: t.title,
              durationMs: t.duration ?? null,
              hasFile: t.hasFile ?? false,
            }),
          ),
        more: await more(),
      };
    }

    const tracks = await this.musicbrainz.tracks(releaseGroupMbid).catch(() => []);
    return {
      ...this.mbReleaseSummary(group, credit.id, artistName),
      artistInLibrary: !!row,
      monitored: null,
      trackFileCount: null,
      trackCount: null,
      genres,
      tracks: tracks.map((t) => ({ ...t, hasFile: null })),
      more: await more(),
    };
  }

  /** Changes whether Lidarr monitors an album that is already in Lidarr. */
  async setAlbumMonitored(releaseGroupMbid: string, monitored: boolean): Promise<AlbumDetail> {
    const { album, lidarrArtistId } = await this.requireLidarrAlbum(releaseGroupMbid);
    await this.client().setAlbumsMonitored([album.id], monitored);
    this.albumCache.delete(lidarrArtistId);
    return this.album(releaseGroupMbid);
  }

  /** Asks Lidarr to search for an album's missing tracks now. */
  async searchAlbum(releaseGroupMbid: string): Promise<void> {
    const { album } = await this.requireLidarrAlbum(releaseGroupMbid);
    await this.client().searchAlbums([album.id]);
  }

  private async requireLidarrAlbum(releaseGroupMbid: string) {
    const group = await this.musicbrainz.releaseGroup(releaseGroupMbid);
    const artistMbid = group['artist-credit']?.[0]?.artist.id;
    const row = artistMbid ? this.library.byMbid(artistMbid) : undefined;
    const album = row ? await this.findLidarrAlbum(row.lidarrId, releaseGroupMbid) : undefined;
    if (!row || !album) throw new HttpError(404, 'That album is not in Lidarr');
    return { album, lidarrArtistId: row.lidarrId };
  }

  private async findLidarrAlbum(lidarrArtistId: number, releaseGroupMbid: string) {
    return (await this.lidarrAlbums(lidarrArtistId)).find((a) => a.foreignAlbumId === releaseGroupMbid);
  }

  // Adding -------------------------------------------------------------------

  /** Adds an artist with the saved defaults. Adding one that exists is a no-op. */
  addArtist(mbid: string, userId: number | null): Promise<ArtistDetail> {
    return this.once(`artist:${mbid}`, async () => {
      if (!this.library.byMbid(mbid)) {
        const settings = this.requireSettings();
        const added = await this.createArtist(mbid, settings, {
          monitored: settings.addMonitored,
          monitorAlbums: settings.addMonitored ? 'all' : 'none',
          search: settings.addMonitored && settings.searchOnAdd,
        });
        this.record(userId, mbid, null, added.id, null);
      }
      return this.artist(mbid);
    });
  }

  /**
   * Adds one album. If the artist is not in Lidarr yet, it is added first with
   * nothing monitored, then only this album is monitored.
   */
  addAlbum(releaseGroupMbid: string, artistMbid: string, userId: number | null): Promise<AlbumDetail> {
    return this.once(`album:${releaseGroupMbid}`, async () => {
      const settings = this.requireSettings();
      const client = this.client();

      let lidarrArtistId = this.library.byMbid(artistMbid)?.lidarrId;
      if (!lidarrArtistId) {
        const added = await this.createArtist(artistMbid, settings, {
          monitored: settings.addMonitored,
          monitorAlbums: 'none',
          search: false,
        });
        lidarrArtistId = added.id;
        // Lidarr's post-add actions reapply "monitor none" once its refresh and
        // rescan finish; monitoring the album before then would be undone.
        await this.waitForArtistSettled(lidarrArtistId);
      }

      const album = await this.waitForAlbum(lidarrArtistId, releaseGroupMbid);
      if (!album.monitored) {
        await this.monitorAndConfirm(lidarrArtistId, album.id, releaseGroupMbid);
        if (settings.searchOnAdd) await client.searchAlbums([album.id]);
      }
      this.albumCache.delete(lidarrArtistId);
      this.library.upsert(await client.artist(lidarrArtistId));
      this.record(userId, artistMbid, releaseGroupMbid, lidarrArtistId, album.id);
      return this.album(releaseGroupMbid);
    });
  }

  /** Changes whether Lidarr monitors an artist that is already in the library. */
  async setMonitored(mbid: string, monitored: boolean): Promise<ArtistDetail> {
    const row = this.library.byMbid(mbid);
    if (!row) throw new HttpError(404, 'That artist is not in your library');
    const client = this.client();
    const raw = await client.rawArtist(row.lidarrId);
    this.library.upsert(await client.updateArtist(row.lidarrId, { ...raw, monitored }));
    this.albumCache.delete(row.lidarrId);
    return this.artist(mbid);
  }

  // Internals ----------------------------------------------------------------

  private async createArtist(
    mbid: string,
    settings: StoredLidarr,
    choice: { monitored: boolean; monitorAlbums: 'all' | 'none'; search: boolean },
  ) {
    const client = this.client();
    const lookup = await this.lookupByMbid(mbid, { fresh: true });
    if (!lookup) throw new HttpError(404, 'Lidarr could not find that artist');
    if (lookup.id) {
      // Already in Lidarr (added elsewhere since the last sync): just refresh the cache.
      const existing = await client.artist(lookup.id);
      this.library.upsert(existing);
      return existing;
    }

    const tags = settings.addTag ? [await client.ensureTag(settings.addTag)] : [];
    const body = {
      ...lookup,
      qualityProfileId: settings.qualityProfileId,
      metadataProfileId: settings.metadataProfileId,
      rootFolderPath: settings.rootFolderPath,
      monitored: choice.monitored,
      monitorNewItems: choice.monitorAlbums,
      tags,
      addOptions: { monitor: choice.monitorAlbums, searchForMissingAlbums: choice.search },
    };
    try {
      const added = await client.addArtist(body);
      this.library.upsert(added, 0);
      this.log.info({ mbid, lidarrId: added.id, monitored: choice.monitored }, 'Artist added to Lidarr');
      return added;
    } catch (error) {
      // Lost a race with another add: treat "already added" as success.
      if (error instanceof LidarrRejected && /already/i.test(error.message)) {
        const again = await this.lookupByMbid(mbid, { fresh: true });
        if (again?.id) {
          const existing = await client.artist(again.id);
          this.library.upsert(existing);
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * Waits until Lidarr has no refresh or rescan queued or running for a newly
   * added artist, and its first refresh has completed.
   */
  private async waitForArtistSettled(lidarrArtistId: number) {
    const deadline = Date.now() + (this.options.albumAppearTimeoutMs ?? ALBUM_APPEAR_TIMEOUT_MS);
    const pollMs = this.options.pollMs ?? 2000;
    for (;;) {
      const mine = (await this.client().commands()).filter(
        (c) => c.body?.artistIds?.includes(lidarrArtistId) || c.body?.artistId === lidarrArtistId,
      );
      const refreshed = mine.some((c) => c.name === 'RefreshArtist' && c.status === 'completed');
      const busy = mine.some((c) => c.status === 'queued' || c.status === 'started');
      if (refreshed && !busy) return;
      if (Date.now() >= deadline) {
        throw new HttpError(422, 'Lidarr is still loading this artist. Try adding the album again in a minute.');
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Monitors one album, then reads it back and reapplies if Lidarr reset it. */
  private async monitorAndConfirm(lidarrArtistId: number, albumId: number, releaseGroupMbid: string) {
    const client = this.client();
    for (let attempt = 0; attempt < 3; attempt++) {
      await client.setAlbumsMonitored([albumId], true);
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 2000));
      this.albumCache.delete(lidarrArtistId);
      const current = await this.findLidarrAlbum(lidarrArtistId, releaseGroupMbid);
      if (current?.monitored) return;
    }
    throw new HttpError(422, 'Lidarr did not keep this album monitored. Check it in Lidarr.');
  }

  /** Lidarr loads a new artist's albums in the background; wait for the one we need. */
  private async waitForAlbum(lidarrArtistId: number, releaseGroupMbid: string): Promise<LidarrAlbum> {
    const deadline = Date.now() + (this.options.albumAppearTimeoutMs ?? ALBUM_APPEAR_TIMEOUT_MS);
    const pollMs = this.options.pollMs ?? 2000;
    for (;;) {
      this.albumCache.delete(lidarrArtistId);
      const albums = await this.lidarrAlbums(lidarrArtistId);
      const album = albums.find((a) => a.foreignAlbumId === releaseGroupMbid);
      if (album) return album;
      if (Date.now() >= deadline) {
        throw new HttpError(
          422,
          albums.length
            ? "Lidarr added the artist, but this release isn't in its metadata profile. Change the profile in Lidarr to include it."
            : 'Lidarr is still loading this artist. Try adding the album again in a minute.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  private async discography(artistMbid: string, artistName: string): Promise<ReleaseSummary[]> {
    const row = this.library.byMbid(artistMbid);
    let releases: ReleaseSummary[];
    const lidarrAlbums = row ? await this.lidarrAlbums(row.lidarrId) : [];
    if (row && lidarrAlbums.length) {
      releases = lidarrAlbums.map((a) => this.lidarrAlbumSummary(a, artistMbid, artistName));
    } else {
      // Not in Lidarr, or just added and Lidarr has not loaded its albums yet.
      const groups = await this.musicbrainz.releaseGroups(artistMbid);
      releases = groups.map((g) => this.mbReleaseSummary(g, artistMbid, artistName));
      if (row?.monitored) releases = releases.map((r) => ({ ...r, status: { kind: 'requested' } }));
    }
    return releases.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));
  }

  private lidarrAlbums(lidarrArtistId: number): Promise<LidarrAlbum[]> {
    const cached = this.albumCache.get(lidarrArtistId);
    if (cached && Date.now() - cached.at < ALBUMS_TTL_MS) return cached.value;
    const value = this.client().albums(lidarrArtistId);
    this.albumCache.set(lidarrArtistId, { at: Date.now(), value });
    value.catch(() => this.albumCache.delete(lidarrArtistId));
    return value;
  }

  private lidarrAlbumSummary(album: LidarrAlbum, artistMbid: string, artistName: string): ReleaseSummary {
    return {
      mbid: album.foreignAlbumId,
      title: album.title,
      type: releaseType(album.albumType, album.secondaryTypes),
      year: yearOf(album.releaseDate),
      coverUrl: this.images.releaseGroupCover(album.foreignAlbumId),
      artistMbid,
      artistName,
      status: lidarrStatus(album),
    };
  }

  private mbReleaseSummary(group: MbReleaseGroup, artistMbid: string, artistName: string): ReleaseSummary {
    return {
      mbid: group.id,
      title: group.title,
      type: releaseType(group['primary-type'], group['secondary-types']),
      year: yearOf(group['first-release-date']),
      coverUrl: this.images.releaseGroupCover(group.id),
      artistMbid,
      artistName,
      status: { kind: 'available' },
    };
  }

  private async lookupAlbumSummary(album: LidarrLookupAlbum): Promise<ReleaseSummary> {
    const artistMbid = album.artist?.foreignArtistId ?? '';
    const artistName = album.artist?.artistName ?? '';
    const row = artistMbid ? this.library.byMbid(artistMbid) : undefined;
    let status: ReleaseSummary['status'] = { kind: 'available' };
    if (row) {
      const match = (await this.lidarrAlbums(row.lidarrId).catch(() => [])).find(
        (a) => a.foreignAlbumId === album.foreignAlbumId,
      );
      if (match) status = lidarrStatus(match);
    }
    return {
      mbid: album.foreignAlbumId,
      title: album.title,
      type: releaseType(album.albumType, album.secondaryTypes),
      year: yearOf(album.releaseDate),
      coverUrl:
        this.images.remote(album.images?.find((i) => i.coverType === 'cover')?.remoteUrl) ??
        this.images.releaseGroupCover(album.foreignAlbumId),
      artistMbid,
      artistName,
      status,
    };
  }

  private lookupArtistSummary(artist: LidarrLookupArtist): ArtistSummary {
    const row = this.library.byMbid(artist.foreignArtistId);
    return {
      mbid: artist.foreignArtistId,
      name: artist.artistName,
      disambiguation: artist.disambiguation || null,
      genres: (artist.genres ?? []).slice(0, 3),
      imageUrl: row
        ? this.library.toArtist(row).imageUrl
        : this.images.remote(remoteImage(artist, 'poster') ?? remoteImage(artist, 'fanart')),
      inLibrary: !!row,
    };
  }

  private libraryArtistSummary(mbid: string, lookup: LidarrLookupArtist | null): ArtistSummary {
    const row = this.library.byMbid(mbid)!;
    const card = this.library.toArtist(row);
    return {
      mbid,
      name: row.name,
      disambiguation: lookup?.disambiguation || null,
      genres: card.genres.slice(0, 3),
      imageUrl: card.imageUrl,
      inLibrary: true,
    };
  }

  private async lookupByMbid(mbid: string, { fresh = false } = {}): Promise<LidarrLookupArtist | null> {
    const key = `artist:lidarr:${mbid}`;
    if (fresh) this.lookups.delete(key);
    const results = await this.cachedLookup(key, () => this.client().lookupArtists(`lidarr:${mbid}`));
    return results.find((a) => a.foreignArtistId === mbid) ?? null;
  }

  private cachedLookup<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.lookups.get(key);
    if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.value as Promise<T>;
    const value = load();
    this.lookups.set(key, { at: Date.now(), value });
    value.catch(() => this.lookups.delete(key));
    if (this.lookups.size > 500) this.lookups.delete(this.lookups.keys().next().value!);
    return value;
  }

  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = this.adding.get(key);
    if (pending) return pending as Promise<T>;
    const promise = run().finally(() => this.adding.delete(key));
    this.adding.set(key, promise);
    return promise;
  }

  private record(userId: number | null, artistMbid: string, albumMbid: string | null, lidarrArtistId: number | null, lidarrAlbumId: number | null) {
    this.db.insert(requests).values({ userId, artistMbid, albumMbid, lidarrArtistId, lidarrAlbumId }).run();
  }

  private requireSettings(): StoredLidarr {
    const settings = loadLidarr(this.settings);
    if (!settings) throw new HttpError(409, 'Connect Lidarr in Settings first');
    return settings;
  }

  private client(): LidarrClient {
    return clientFor(this.requireSettings(), this.options.timeoutMs);
  }
}

function remoteImage(artist: LidarrLookupArtist | null, type: string): string | null {
  return artist?.images?.find((i) => i.coverType === type)?.remoteUrl ?? null;
}
