import type { LibraryArtist, LibraryResponse, LibrarySync } from '@offbeat/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { jobs, libraryArtists } from '../db/schema.js';
import { LidarrError, type LidarrArtist } from '../integrations/lidarr/client.js';
import { clientFor, loadLidarr } from '../integrations/lidarr/settings.js';
import type { SettingsStore } from '../settings/store.js';

const JOB = 'library-sync';
/** `GET /library` refreshes in the background once the cache is older than this. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

type Row = typeof libraryArtists.$inferSelect;

/**
 * Offbeat's cached copy of the Lidarr library. Reads never wait on Lidarr;
 * syncs replace the cache wholesale and record their outcome in `jobs`.
 */
export class Library {
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly log: FastifyBaseLogger,
    private readonly timeoutMs?: number,
  ) {}

  /** Cached artists plus sync status. Kicks off a background sync when stale. */
  read(): LibraryResponse {
    this.refreshIfStale();
    return this.snapshot();
  }

  /** Waits for a sync (starting one if needed) and returns the result. Never throws for Lidarr failures. */
  async refresh(): Promise<LibraryResponse> {
    await this.sync().catch(() => undefined);
    return this.snapshot();
  }

  /** Runs one sync, or joins the one already in flight. */
  sync(): Promise<void> {
    this.running ??= this.runSync().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  refreshIfStale(now = Date.now()) {
    if (this.running || !loadLidarr(this.settings)) return;
    const last = this.job()?.lastRunAt?.getTime() ?? 0;
    if (now - last >= STALE_AFTER_MS) {
      this.sync().catch(() => undefined); // outcome is recorded in jobs
    }
  }

  /** Finds a cached artist, for the image proxy. */
  artist(lidarrId: number): Row | undefined {
    return this.db.select().from(libraryArtists).where(eq(libraryArtists.lidarrId, lidarrId)).get();
  }

  private snapshot(): LibraryResponse {
    const rows = this.db.select().from(libraryArtists).all();
    return { artists: rows.map(toLibraryArtist), sync: this.status() };
  }

  private status(): LibrarySync {
    const job = this.job();
    const lastSyncedAt = job?.lastSuccessAt?.toISOString() ?? null;
    if (this.running) return { state: 'syncing', lastSyncedAt, error: null };
    if (!job) return { state: 'never', lastSyncedAt, error: null };
    if (job.error) return { state: 'error', lastSyncedAt, error: job.error };
    return { state: 'ok', lastSyncedAt, error: null };
  }

  private job() {
    return this.db.select().from(jobs).where(eq(jobs.name, JOB)).get();
  }

  private async runSync() {
    const settings = loadLidarr(this.settings);
    if (!settings) return;
    const started = Date.now();
    const client = clientFor(settings, this.timeoutMs);
    try {
      const [artists, missing] = await Promise.all([client.artists(), client.missingAlbumCounts()]);
      const rows = artists.map((artist) => toRow(artist, missing.get(artist.id) ?? 0));
      this.db.transaction((tx) => {
        tx.delete(libraryArtists).run();
        // Chunked to stay under SQLite's bound-parameter limit.
        for (let i = 0; i < rows.length; i += 200) {
          tx.insert(libraryArtists).values(rows.slice(i, i + 200)).run();
        }
        tx.insert(jobs)
          .values({ name: JOB, lastRunAt: new Date(), lastSuccessAt: new Date(), error: null })
          .onConflictDoUpdate({
            target: jobs.name,
            set: { lastRunAt: new Date(), lastSuccessAt: new Date(), error: null },
          })
          .run();
      });
      this.log.info({ artists: rows.length, ms: Date.now() - started }, 'Library synced from Lidarr');
    } catch (error) {
      const message =
        error instanceof LidarrError ? error.message : 'Library sync failed. Check the server logs.';
      this.db
        .insert(jobs)
        .values({ name: JOB, lastRunAt: new Date(), error: message })
        .onConflictDoUpdate({ target: jobs.name, set: { lastRunAt: new Date(), error: message } })
        .run();
      this.log.warn({ err: error }, 'Library sync failed');
      throw error;
    }
  }
}

function toRow(artist: LidarrArtist, missingAlbums: number): typeof libraryArtists.$inferInsert {
  const images = artist.images ?? [];
  // Round portraits look best from the poster; fall back to other artwork.
  const image =
    images.find((i) => i.coverType === 'poster' && (i.url || i.remoteUrl)) ??
    images.find((i) => i.coverType === 'fanart' && (i.url || i.remoteUrl)) ??
    images.find((i) => i.url || i.remoteUrl);
  const stats = artist.statistics;
  return {
    lidarrId: artist.id,
    mbid: artist.foreignArtistId,
    name: artist.artistName,
    sortName: artist.sortName || artist.artistName,
    monitored: artist.monitored,
    addedAt: new Date(artist.added),
    albumCount: stats?.albumCount ?? 0,
    trackCount: stats?.trackCount ?? 0,
    trackFileCount: stats?.trackFileCount ?? 0,
    sizeOnDisk: stats?.sizeOnDisk ?? 0,
    missingAlbums,
    genres: JSON.stringify(artist.genres ?? []),
    imagePath: image?.url ?? null,
    imageRemoteUrl: image?.remoteUrl ?? null,
  };
}

/** Changes whenever Lidarr's artwork changes, so the proxy URL can be cached forever. */
export function imageVersion(row: Pick<Row, 'imagePath' | 'imageRemoteUrl'>): string | null {
  const source = row.imagePath ?? row.imageRemoteUrl;
  return source ? createHash('sha256').update(source).digest('hex').slice(0, 16) : null;
}

function toLibraryArtist(row: Row): LibraryArtist {
  const version = imageVersion(row);
  return {
    id: row.lidarrId,
    mbid: row.mbid,
    name: row.name,
    sortName: row.sortName,
    monitored: row.monitored,
    addedAt: row.addedAt.toISOString(),
    albumCount: row.albumCount,
    missingAlbums: row.missingAlbums,
    sizeOnDisk: row.sizeOnDisk,
    genres: JSON.parse(row.genres) as string[],
    imageUrl: version ? `api/v1/images/artist/${row.lidarrId}?v=${version}` : null,
  };
}
