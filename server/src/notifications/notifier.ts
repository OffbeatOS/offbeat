import type {
  ActivityItem,
  ChannelKind,
  Delivery,
  DeliveryResult,
  NotificationEvent,
  WebhookPayload,
} from '@offbeat/shared';
import { NOTIFICATION_EVENTS } from '@offbeat/shared';
import { desc, eq, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { deliveries } from '../db/schema.js';
import type { LidarrCalendarAlbum, LidarrClient, LidarrHistoryItem } from '../integrations/lidarr/client.js';
import type { SettingsStore } from '../settings/store.js';
import { type Message, PermanentError, RetryableError, sendDiscord, sendWebhook } from './channels.js';

const SETTINGS = 'notifications';
const STATE = 'notifications-state';

const event = z.enum(NOTIFICATION_EVENTS as [NotificationEvent, ...NotificationEvent[]]);
const result = z.object({ ok: z.boolean(), at: z.string(), error: z.string().nullable() });
export const notificationSettingsSchema = z.object({
  publicUrl: z.string().nullable().default(null),
  discord: z
    .object({ enabled: z.boolean(), url: z.string(), events: z.array(event), lastTest: result.nullable().default(null) })
    .nullable()
    .default(null),
  webhook: z
    .object({
      enabled: z.boolean(),
      url: z.string(),
      secret: z.string().nullable(),
      events: z.array(event),
      lastTest: result.nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

const stateSchema = z.object({
  /** The newest Lidarr history entry already considered; null until the first look (which only records it). */
  lastHistoryId: z.number().nullable().default(null),
  /** Calendar albums already seen; null until the first check (which only records them). */
  knownReleases: z.array(z.number()).nullable().default(null),
});

export interface NotifierOptions {
  /** Waits before each retry of a failed send. */
  retryDelaysMs?: number[];
  /** How often to look at Lidarr's calendar for new releases; null turns it off (tests). */
  releaseCheckMs?: number | null;
}

const DEFAULT_RETRIES_MS = [30_000, 120_000, 600_000];
const RELEASE_CHECK_MS = 15 * 60_000;
/** History older than this is not news (for example after Offbeat was down for a day). */
const HISTORY_MAX_AGE_MS = 6 * 3600_000;
/** An artist's albums only count as new releases after its first day in Lidarr. */
const NEW_ARTIST_GRACE_MS = 24 * 3600_000;
const KEEP_DELIVERIES = 200;

const TITLES: Record<NotificationEvent | 'test', string> = {
  'album-imported': 'Album imported',
  'download-failed': 'Download failed',
  'import-blocked': 'Import blocked',
  'new-release': 'New release',
  test: 'Test from Offbeat',
};

interface Subject {
  artist: { mbid: string | null; name: string } | null;
  album: { mbid: string | null; title: string } | null;
  reason?: string | null;
  /** Overrides "Album by Artist". */
  message?: string;
}

/**
 * Tells Discord and generic webhooks about downloads and releases. Sources:
 * Lidarr's history (album imported, download failed; one message per album
 * download, however many tracks), Activity (an import newly blocked or
 * stuck), and Lidarr's calendar (a monitored artist's album appearing that
 * was not there before). Sending never blocks anything else: it runs in the
 * background, retries a few times, and records every attempt.
 */
export class Notifier {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** One send at a time per channel, so a burst does not trip Discord's rate limit. */
  private readonly lanes = new Map<ChannelKind, Promise<void>>();
  private attentionSeen: Set<string> | null = null;
  private releaseTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly log: FastifyBaseLogger,
    private readonly lidarr: () => LidarrClient | null,
    private readonly options: NotifierOptions = {},
  ) {}

  start() {
    // Retries do not survive a restart; say so rather than leave them "retrying" forever.
    try {
      this.db
        .update(deliveries)
        .set({ status: 'failed', error: 'Offbeat restarted before the retry', updatedAt: new Date() })
        .where(eq(deliveries.status, 'retrying'))
        .run();
    } catch (error) {
      this.log.warn({ err: error }, 'Could not tidy up notification deliveries');
    }
    const every = this.options.releaseCheckMs === undefined ? RELEASE_CHECK_MS : this.options.releaseCheckMs;
    if (every) {
      void this.checkNewReleases().catch(() => undefined);
      this.releaseTimer = setInterval(() => void this.checkNewReleases().catch(() => undefined), every);
      this.releaseTimer.unref();
    }
  }

  stop() {
    if (this.releaseTimer) clearInterval(this.releaseTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  load(): NotificationSettings {
    return this.settings.get(SETTINGS, notificationSettingsSchema) ?? { publicUrl: null, discord: null, webhook: null };
  }

  save(value: NotificationSettings) {
    this.settings.set(SETTINGS, value, { encrypted: true });
  }

  private state() {
    return this.settings.get(STATE, stateSchema) ?? { lastHistoryId: null, knownReleases: null };
  }

  private setState(change: Partial<z.infer<typeof stateSchema>>) {
    this.settings.set(STATE, { ...this.state(), ...change }, { encrypted: false });
  }

  // Sources --------------------------------------------------------------------

  /** New Lidarr history since the last look: imported and failed downloads, one message per album. */
  noticeHistory(records: LidarrHistoryItem[], now = Date.now()) {
    if (!records.length) return;
    const newest = Math.max(...records.map((r) => r.id));
    const { lastHistoryId } = this.state();
    if (lastHistoryId === null) {
      this.setState({ lastHistoryId: newest }); // the first look only records where things stand
      return;
    }
    if (newest <= lastHistoryId) return;
    this.setState({ lastHistoryId: newest });

    const groups = new Map<string, LidarrHistoryItem>();
    for (const r of records) {
      if (r.id <= lastHistoryId || now - Date.parse(r.date) > HISTORY_MAX_AGE_MS) continue;
      if (r.eventType !== 'downloadImported' && r.eventType !== 'downloadFailed') continue;
      // Several entries for one download (or album) are one message.
      const key = `${r.eventType}:${r.downloadId ?? `album-${r.albumId ?? r.id}`}`;
      if (!groups.has(key)) groups.set(key, r);
    }
    // Oldest first, as they happened.
    for (const r of [...groups.values()].sort((a, b) => a.id - b.id)) {
      const subject: Subject = {
        artist: r.artist ? { mbid: r.artist.foreignArtistId, name: r.artist.artistName } : null,
        album: r.album ? { mbid: r.album.foreignAlbumId, title: r.album.title } : { mbid: null, title: r.sourceTitle ?? 'An album' },
      };
      if (r.eventType === 'downloadImported') this.notify('album-imported', subject);
      else this.notify('download-failed', { ...subject, reason: typeof r.data?.['message'] === 'string' ? r.data['message'] : null });
    }
  }

  /** Activity's Needs Attention: an import newly blocked or stuck. The first look only records what is there. */
  noticeAttention(items: ActivityItem[]) {
    const blocked = items.filter((i) => i.state === 'import-blocked' || i.state === 'import-stuck');
    if (this.attentionSeen === null) {
      this.attentionSeen = new Set(blocked.map((i) => i.id));
      return;
    }
    for (const item of blocked) {
      if (this.attentionSeen.has(item.id)) continue;
      this.attentionSeen.add(item.id);
      this.notify('import-blocked', {
        artist: item.artistName ? { mbid: item.artistMbid, name: item.artistName } : null,
        album: { mbid: item.albumMbid, title: item.albumTitle },
        reason: item.reason,
      });
    }
  }

  /**
   * New releases: Lidarr adds albums to monitored artists when it refreshes
   * their metadata. Its calendar (released in the last week, or due in the
   * next 90 days) is checked every 15 minutes; an album that appears there
   * for a monitored artist, and was not there before, is news. The first
   * check only records what is there, and an artist's albums do not count
   * during its first day in Lidarr, so adding an artist sends nothing.
   */
  async checkNewReleases(now = new Date()) {
    const client = this.lidarr();
    if (!client) return;
    const albums = await client.calendar(new Date(now.getTime() - 7 * 86_400_000), new Date(now.getTime() + 90 * 86_400_000));
    const { knownReleases } = this.state();
    this.setState({ knownReleases: albums.map((a) => a.id) });
    if (knownReleases === null) return;
    const known = new Set(knownReleases);
    for (const album of albums) {
      if (known.has(album.id) || !album.artist?.monitored) continue;
      const added = album.artist.added ? Date.parse(album.artist.added) : 0;
      if (now.getTime() - added < NEW_ARTIST_GRACE_MS) continue;
      this.notify('new-release', {
        artist: { mbid: album.artist.foreignArtistId, name: album.artist.artistName },
        album: { mbid: album.foreignAlbumId, title: album.title },
        message: `${album.title} by ${album.artist.artistName}, ${releaseWhen(album, now)}`,
      });
    }
  }

  // Sending ---------------------------------------------------------------------

  /** Queues a message to every enabled channel that wants this event. Never throws, never waits. */
  notify(kind: NotificationEvent, subject: Subject) {
    const settings = this.load();
    const message = this.message(kind, subject, settings.publicUrl);
    for (const channel of ['discord', 'webhook'] as const) {
      const config = settings[channel];
      if (!config?.enabled || !config.events.includes(kind)) continue;
      const row = this.db
        .insert(deliveries)
        .values({ channel, event: kind, title: message.payload.title, message: message.payload.message, status: 'retrying', attempts: 0 })
        .returning({ id: deliveries.id })
        .get();
      this.enqueue(channel, row.id, message, 0);
    }
    this.prune();
  }

  /** Send Test: one attempt, answered straight away, and recorded. */
  async sendTest(channel: ChannelKind): Promise<DeliveryResult> {
    const settings = this.load();
    const config = settings[channel];
    if (!config) throw new Error('Set up this channel first');
    const message = this.message('test', {
      artist: null,
      album: null,
      message: 'Offbeat can reach this channel',
    }, settings.publicUrl);
    const row = this.db
      .insert(deliveries)
      .values({ channel, event: 'test', title: message.payload.title, message: message.payload.message, status: 'retrying', attempts: 1 })
      .returning({ id: deliveries.id })
      .get();
    let error: string | null = null;
    try {
      await this.send(channel, message);
    } catch (e) {
      error = e instanceof Error ? e.message : 'The test failed';
    }
    this.finish(row.id, error ? 'failed' : 'delivered', 1, error);
    const outcome: DeliveryResult = { ok: !error, at: new Date().toISOString(), error };
    const latest = this.load();
    if (latest[channel]) this.save({ ...latest, [channel]: { ...latest[channel]!, lastTest: outcome } });
    return outcome;
  }

  recent(limit = 30): Delivery[] {
    return this.db
      .select()
      .from(deliveries)
      .orderBy(desc(deliveries.id))
      .limit(limit)
      .all()
      .map((d) => ({
        id: d.id,
        channel: d.channel,
        event: d.event as Delivery['event'],
        title: d.title,
        message: d.message,
        status: d.status,
        attempts: d.attempts,
        error: d.error,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      }));
  }

  private enqueue(channel: ChannelKind, id: number, message: Message, attempts: number) {
    const previous = this.lanes.get(channel) ?? Promise.resolve();
    const next = previous.then(() => this.attempt(channel, id, message, attempts)).catch(() => undefined);
    this.lanes.set(channel, next);
  }

  private async attempt(channel: ChannelKind, id: number, message: Message, before: number) {
    const attempts = before + 1;
    try {
      await this.send(channel, message);
      this.finish(id, 'delivered', attempts, null);
    } catch (error) {
      const why = error instanceof Error ? error.message : 'Could not send';
      const delays = this.options.retryDelaysMs ?? DEFAULT_RETRIES_MS;
      if (error instanceof PermanentError || !(error instanceof RetryableError) || attempts > delays.length) {
        this.finish(id, 'failed', attempts, why);
        this.log.warn({ channel, event: message.payload.event, err: why }, 'Notification not delivered');
        return;
      }
      this.finish(id, 'retrying', attempts, why);
      const wait = error.retryAfterMs ?? delays[attempts - 1]!;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.enqueue(channel, id, message, attempts);
      }, wait);
      timer.unref();
      this.timers.add(timer);
    }
  }

  private async send(channel: ChannelKind, message: Message) {
    const config = this.load()[channel];
    if (!config) throw new PermanentError('This channel was removed');
    if (channel === 'discord') await sendDiscord(config.url, message);
    else await sendWebhook(config.url, (config as NonNullable<NotificationSettings['webhook']>).secret, message);
  }

  private finish(id: number, status: Delivery['status'], attempts: number, error: string | null) {
    this.db.update(deliveries).set({ status, attempts, error, updatedAt: new Date() }).where(eq(deliveries.id, id)).run();
  }

  private prune() {
    const cutoff = this.db.select({ id: deliveries.id }).from(deliveries).orderBy(desc(deliveries.id)).limit(1).offset(KEEP_DELIVERIES).get();
    if (cutoff) this.db.delete(deliveries).where(lt(deliveries.id, cutoff.id + 1)).run();
  }

  private message(kind: NotificationEvent | 'test', subject: Subject, publicUrl: string | null): Message {
    const base = publicUrl?.replace(/\/+$/, '') ?? null;
    const link = !base
      ? null
      : subject.album?.mbid
        ? `${base}/album/${subject.album.mbid}`
        : subject.artist?.mbid
          ? `${base}/artist/${subject.artist.mbid}`
          : kind === 'test'
            ? base
            : null;
    const text =
      subject.message ??
      (subject.album && subject.artist ? `${subject.album.title} by ${subject.artist.name}` : (subject.album?.title ?? subject.artist?.name ?? ''));
    const payload: WebhookPayload = {
      version: 1,
      event: kind,
      title: TITLES[kind],
      message: text,
      url: link,
      artist: subject.artist,
      album: subject.album,
      reason: subject.reason ?? null,
      occurredAt: new Date().toISOString(),
    };
    return { payload };
  }
}

function releaseWhen(album: LidarrCalendarAlbum, now: Date): string {
  if (!album.releaseDate) return 'coming soon';
  const date = new Date(album.releaseDate);
  const day = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return date.getTime() <= now.getTime() ? `out ${day}` : `due ${day}`;
}
