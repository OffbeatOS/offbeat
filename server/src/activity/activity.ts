import type { ActivityItem, ActivitySnapshot, AddResult, CompletedItem } from '@offbeat/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Catalog } from '../catalog/catalog.js';
import type { Db } from '../db/index.js';
import { requests, users } from '../db/schema.js';
import {
  type LidarrAlbumRef,
  type LidarrClient,
  LidarrError,
  type LidarrHistoryItem,
  type LidarrQueueItem,
} from '../integrations/lidarr/client.js';
import { clientFor, loadLidarr } from '../integrations/lidarr/settings.js';
import type { MusicBrainzClient } from '../integrations/musicbrainz/client.js';
import type { ImageUrls } from '../library/image-urls.js';
import type { Library } from '../library/library.js';
import type { SettingsStore } from '../settings/store.js';
import { ACTIVE_STATES, ATTENTION_STATES, describeQueueItem } from './mapping.js';

export type ActivityEvent = { type: 'activity'; data: ActivitySnapshot } | { type: 'add-result'; data: AddResult };
type Listener = (event: ActivityEvent) => void;

interface PendingAdd {
  albumMbid: string;
  artistMbid: string;
  albumTitle: string;
  artistName: string;
  userId: number | null;
}

interface FailedAdd extends PendingAdd {
  error: string;
  at: number;
}

export interface ActivityOptions {
  /** Start polling when the app is ready. Default true; tests that drive polling by hand turn it off. */
  autoStart?: boolean;
  /** Poll interval while something is moving and a browser is watching. */
  activeMs?: number;
  /** Poll interval when nothing is moving but a browser is watching. */
  watchedIdleMs?: number;
  /** Poll interval with no browsers connected. */
  unwatchedMs?: number;
  /** How long to keep the active interval after something that may lead to a grab. */
  burstMs?: number;
  /** How often to reread Lidarr's history (imports, and grabs made from Lidarr). */
  historyEveryMs?: number;
  /** A poll taking longer than this is abandoned, so one stuck request cannot stop Activity. */
  pollTimeoutMs?: number;
}

const FAILED_ADD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The single poller for Lidarr's activity. Browsers subscribe (over SSE)
 * instead of polling Lidarr themselves; the poll rate follows how busy things
 * are and whether anyone is watching. Also runs Offbeat's background album
 * adds, so a slow add never blocks a request.
 */
export class Activity {
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<string, PendingAdd>();
  private readonly failedAdds = new Map<string, FailedAdd>();
  private readonly albumRefs = new Map<number, LidarrAlbumRef>();
  private snapshot: ActivitySnapshot = { attention: [], inProgress: [], completed: [], updatedAt: null, error: null };
  private lastKey = '';
  private history: LidarrHistoryItem[] = [];
  private historyAt = 0;
  private queueIds = new Set<number>();
  /** Newest "grabbed" history event seen, so a new grab can be noticed. */
  private lastGrabId: number | null = null;
  /** Poll at the active interval until then, even while the queue looks idle. */
  private burstUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  /** What the current poll is waiting on, for the log when one gets stuck. */
  private stage = 'idle';
  private stopped = true;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly library: Library,
    private readonly catalog: Catalog,
    private readonly musicbrainz: MusicBrainzClient,
    private readonly images: ImageUrls,
    private readonly log: FastifyBaseLogger,
    private readonly options: ActivityOptions = {},
  ) {
    catalog.isAdding = (mbid) => this.pending.has(mbid);
  }

  start() {
    this.stopped = false;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  current(): ActivitySnapshot {
    return this.snapshot;
  }

  /** Receive every change. The current snapshot is sent right away. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ type: 'activity', data: this.snapshot });
    if (this.listeners.size === 1) this.wake(); // someone started watching: get fresh data now
    return () => this.listeners.delete(listener);
  }

  get subscriberCount() {
    return this.listeners.size;
  }

  /**
   * Something may soon show up in the queue (a search, a retry, an add):
   * poll now, and keep polling quickly for a while. Searches can grab and a
   * small download can finish between two idle polls.
   */
  expectMovement(): Promise<void> {
    this.burstUntil = Date.now() + (this.options.burstMs ?? 180_000);
    return this.wake();
  }

  /** Polls now instead of waiting (after an add, a retry, or a cancel). */
  wake(): Promise<void> {
    if (this.stopped) return this.refresh();
    this.schedule(0);
    return this.running ?? Promise.resolve();
  }

  /**
   * Starts adding an album in the background. Returns at once; the result
   * arrives as an `add-result` event and in Activity.
   */
  async startAlbumAdd(albumMbid: string, artistMbid: string, userId: number | null): Promise<void> {
    if (this.pending.has(albumMbid)) return;
    const group = await this.musicbrainz.releaseGroup(albumMbid).catch(() => null);
    const add: PendingAdd = {
      albumMbid,
      artistMbid,
      albumTitle: group?.title ?? 'Album',
      artistName: group?.['artist-credit']?.[0]?.name ?? '',
      userId,
    };
    this.pending.set(albumMbid, add);
    this.failedAdds.delete(albumMbid);
    void this.expectMovement();

    void this.catalog
      .addAlbum(albumMbid, artistMbid, userId)
      .then((detail) => {
        this.emit({ type: 'add-result', data: { albumMbid, ok: true, status: detail.status, error: null } });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Could not add this album';
        this.failedAdds.set(albumMbid, { ...add, error: message, at: Date.now() });
        this.log.warn({ albumMbid, err: error }, 'Background album add failed');
        this.emit({ type: 'add-result', data: { albumMbid, ok: false, status: null, error: message } });
      })
      .finally(() => {
        this.pending.delete(albumMbid);
        void this.expectMovement();
      });
  }

  /** Retry: a failed Offbeat add runs again; a failed or blocked download is blocklisted and searched again. */
  async retry(id: string): Promise<void> {
    const [kind, key] = splitId(id);
    if (kind === 'add') {
      const failed = this.failedAdds.get(key);
      if (!failed) throw new NotFound();
      await this.startAlbumAdd(failed.albumMbid, failed.artistMbid, failed.userId);
      return;
    }
    if (kind !== 'queue') throw new NotFound();
    const item = (await this.client().queue()).find((q) => q.id === Number(key));
    if (!item) throw new NotFound();
    await this.client().removeQueueItem(item.id, { blocklist: true });
    if (item.albumId) await this.client().searchAlbums([item.albumId]);
    this.log.info({ queueId: item.id, albumId: item.albumId }, 'Retried download: blocklisted and searching again');
    await this.expectMovement();
  }

  /** Cancel: removes a download from the queue without blocklisting it. */
  async cancel(id: string): Promise<void> {
    const [kind, key] = splitId(id);
    if (kind !== 'queue') throw new NotFound();
    await this.client().removeQueueItem(Number(key), { blocklist: false });
    await this.wake();
  }

  // Polling --------------------------------------------------------------------

  private schedule(delayMs: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // A poll never takes the loop down with it.
      void this.refresh()
        .catch((error: unknown) => this.log.warn({ err: error }, 'Activity poll failed'))
        .finally(() => this.schedule(this.nextDelay()));
    }, delayMs);
  }

  private nextDelay(): number {
    const moving =
      Date.now() < this.burstUntil || this.snapshot.inProgress.some((item) => ACTIVE_STATES.has(item.state));
    if (this.listeners.size === 0) return moving ? 15_000 : (this.options.unwatchedMs ?? 120_000);
    return moving ? (this.options.activeMs ?? 3000) : (this.options.watchedIdleMs ?? 30_000);
  }

  /** One poll. Concurrent callers share the same run. */
  refresh(): Promise<void> {
    this.running ??= this.pollWithTimeout().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** One poll, abandoned (and reported) if it outlives `pollTimeoutMs`. */
  private async pollWithTimeout() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = this.options.pollTimeoutMs ?? 45_000;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), limit);
    });
    try {
      const outcome = await Promise.race([this.poll().then(() => 'done' as const), timedOut]);
      if (outcome === 'timeout') {
        this.log.warn({ stage: this.stage, ms: limit }, 'Lidarr activity poll got stuck; abandoned it');
        this.publish({ ...this.snapshot }, 'Lidarr is taking too long to answer. Showing the last known activity.');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async poll() {
    let settings;
    try {
      // Inside the try: during shutdown the database can close under a running poll.
      settings = loadLidarr(this.settings);
    } catch (error) {
      this.log.debug({ err: error }, 'Activity poll skipped: settings unavailable');
      return;
    }
    if (!settings) return;
    const client = clientFor(settings);
    try {
      this.stage = 'queue and commands';
      const [queue, commands] = await Promise.all([client.queue(), client.commands()]);
      const queueIds = new Set(queue.map((q) => q.id));
      const finished = [...this.queueIds].some((id) => !queueIds.has(id));
      this.queueIds = queueIds;
      if (finished || Date.now() - this.historyAt > (this.options.historyEveryMs ?? 30_000)) {
        this.stage = 'history';
        this.history = await client.history(60);
        this.historyAt = Date.now();
        this.noticeGrabs();
      }
      if (finished) {
        // Something left the queue (imported or removed): refresh album statuses.
        this.catalog.forgetAlbums();
        void this.library.sync().catch(() => undefined);
      }
      this.stage = 'searching albums';
      const searching = await this.searchingAlbums(client, commands, queue);
      this.stage = 'building the snapshot';
      this.publish(this.build(settings.url, queue, searching), null);
      this.stage = 'idle';
      this.log.debug({ queue: queue.length, searching: searching.length }, 'Polled Lidarr activity');
    } catch (error) {
      const message = error instanceof LidarrError ? error.message : 'Could not load activity from Lidarr';
      this.log.warn({ err: error }, 'Could not poll Lidarr activity');
      this.publish({ ...this.snapshot }, message);
    }
  }

  /** A grab we have not seen yet (for example a search started in Lidarr): watch closely. */
  private noticeGrabs() {
    const newest = this.history.find((h) => h.eventType === 'grabbed');
    if (!newest) return;
    if (this.lastGrabId !== null && newest.id !== this.lastGrabId) {
      this.burstUntil = Date.now() + (this.options.burstMs ?? 180_000);
    }
    this.lastGrabId = newest.id;
  }

  private async searchingAlbums(
    client: LidarrClient,
    commands: Awaited<ReturnType<LidarrClient['commands']>>,
    queue: LidarrQueueItem[],
  ): Promise<LidarrAlbumRef[]> {
    const inQueue = new Set(queue.map((q) => q.albumId));
    const ids = new Set<number>();
    for (const command of commands) {
      if (command.name !== 'AlbumSearch' || !['queued', 'started'].includes(command.status)) continue;
      for (const id of command.body?.albumIds ?? []) if (!inQueue.has(id)) ids.add(id);
    }
    const refs: LidarrAlbumRef[] = [];
    for (const id of ids) {
      let ref = this.albumRefs.get(id);
      if (!ref) {
        ref = await client.albumById(id).catch(() => undefined);
        if (ref) this.albumRefs.set(id, ref);
      }
      if (ref) refs.push(ref);
    }
    return refs;
  }

  private build(lidarrUrl: string, queue: LidarrQueueItem[], searching: LidarrAlbumRef[]): ActivitySnapshot {
    const sources = this.requestSources();
    const sourceFor = (albumMbid: string | null | undefined, albumId: number | null | undefined) =>
      (albumId != null && sources.byAlbumId.get(albumId)) || (albumMbid && sources.byMbid.get(albumMbid)) || 'Added in Lidarr';

    const items: ActivityItem[] = [];

    for (const add of this.pending.values()) {
      items.push({
        ...this.base(`add:${add.albumMbid}`, add.albumMbid, add.albumTitle, add.artistMbid, add.artistName),
        state: 'adding',
        detail: 'Adding to Lidarr',
        source: add.userId ? (sources.users.get(add.userId) ?? 'Requested in Offbeat') : 'Requested in Offbeat',
      });
    }
    this.pruneFailedAdds();
    for (const failed of this.failedAdds.values()) {
      items.push({
        ...this.base(`add:${failed.albumMbid}`, failed.albumMbid, failed.albumTitle, failed.artistMbid, failed.artistName),
        state: 'failed',
        detail: 'Could not add',
        reason: failed.error,
        canRetry: true,
        source: failed.userId ? (sources.users.get(failed.userId) ?? 'Requested in Offbeat') : 'Requested in Offbeat',
      });
    }
    for (const ref of searching) {
      items.push({
        ...this.base(`search:${ref.id}`, ref.foreignAlbumId, ref.title, ref.artist?.foreignArtistId ?? null, ref.artist?.artistName ?? ''),
        state: 'searching',
        detail: 'Checking indexers',
        source: sourceFor(ref.foreignAlbumId, ref.id),
      });
    }
    for (const q of queue) {
      const albumMbid = q.album?.foreignAlbumId ?? null;
      const described = describeQueueItem(q);
      items.push({
        ...this.base(
          `queue:${q.id}`,
          albumMbid,
          q.album?.title ?? q.title ?? 'Unknown release',
          q.artist?.foreignArtistId ?? null,
          q.artist?.artistName ?? '',
        ),
        ...described,
        source: sourceFor(albumMbid, q.albumId),
        lidarrLink:
          described.state === 'import-blocked'
            ? `${lidarrUrl}/activity/queue`
            : described.state === 'failed' && albumMbid
              ? `${lidarrUrl}/album/${albumMbid}`
              : null,
      });
    }

    const completed: CompletedItem[] = this.history
      .filter((h) => h.eventType === 'downloadImported')
      .slice(0, 20)
      .map((h) => ({
        id: `history:${h.id}`,
        albumMbid: h.album?.foreignAlbumId ?? null,
        albumTitle: h.album?.title ?? h.sourceTitle ?? 'Unknown release',
        artistMbid: h.artist?.foreignArtistId ?? null,
        artistName: h.artist?.artistName ?? '',
        coverUrl: h.album?.foreignAlbumId ? this.images.releaseGroupCover(h.album.foreignAlbumId) : null,
        date: h.date,
        source: sourceFor(h.album?.foreignAlbumId, h.albumId),
      }));

    return {
      attention: items.filter((i) => ATTENTION_STATES.has(i.state)),
      inProgress: items.filter((i) => !ATTENTION_STATES.has(i.state)),
      completed,
      updatedAt: new Date().toISOString(),
      error: null,
    };
  }

  private base(
    id: string,
    albumMbid: string | null,
    albumTitle: string,
    artistMbid: string | null,
    artistName: string,
  ): ActivityItem {
    return {
      id,
      state: 'queued',
      albumMbid,
      albumTitle,
      artistMbid,
      artistName,
      coverUrl: albumMbid ? this.images.releaseGroupCover(albumMbid) : null,
      progress: null,
      detail: '',
      reason: null,
      messages: [],
      source: 'Added in Lidarr',
      canRetry: false,
      canCancel: false,
      lidarrLink: null,
    };
  }

  /** "requested by <user>" for adds made through Offbeat, keyed by Lidarr album id and by MBID. */
  private requestSources() {
    const rows = this.db
      .select({ albumId: requests.lidarrAlbumId, albumMbid: requests.albumMbid, username: users.username, userId: users.id })
      .from(requests)
      .leftJoin(users, eq(requests.userId, users.id))
      .all();
    const byAlbumId = new Map<number, string>();
    const byMbid = new Map<string, string>();
    const names = new Map<number, string>();
    for (const row of rows) {
      const label = row.username ? `requested by ${row.username}` : 'Requested in Offbeat';
      if (row.albumId != null) byAlbumId.set(row.albumId, label);
      if (row.albumMbid) byMbid.set(row.albumMbid, label);
    }
    for (const user of this.db.select({ id: users.id, username: users.username }).from(users).all()) {
      names.set(user.id, `requested by ${user.username}`);
    }
    return { byAlbumId, byMbid, users: names };
  }

  private publish(snapshot: ActivitySnapshot, error: string | null) {
    const next = { ...snapshot, error, updatedAt: error ? snapshot.updatedAt : snapshot.updatedAt };
    const key = JSON.stringify({ ...next, updatedAt: null });
    this.snapshot = next;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.emit({ type: 'activity', data: next });
  }

  private emit(event: ActivityEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log.warn({ err: error }, 'Activity listener failed');
      }
    }
  }

  private pruneFailedAdds() {
    const cutoff = Date.now() - FAILED_ADD_TTL_MS;
    for (const [key, failed] of this.failedAdds) if (failed.at < cutoff) this.failedAdds.delete(key);
  }

  private client(): LidarrClient {
    const settings = loadLidarr(this.settings);
    if (!settings) throw new LidarrError('Connect Lidarr in Settings first');
    return clientFor(settings);
  }
}

export class NotFound extends Error {}

function splitId(id: string): [string, string] {
  const index = id.indexOf(':');
  return index < 0 ? ['', ''] : [id.slice(0, index), id.slice(index + 1)];
}
