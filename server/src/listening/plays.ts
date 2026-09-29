import type { ListenBrainzSubmitView, PlayedTrack } from '@offbeat/shared';
import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { plays } from '../db/schema.js';
import type { LidarrClient } from '../integrations/lidarr/client.js';
import { type ListenBrainzClient, ListenBrainzTokenRejected } from '../integrations/listenbrainz/client.js';
import type { ImageUrls } from '../library/image-urls.js';
import { mimeTypeFor } from '../library/music-files.js';
import type { SettingsStore } from '../settings/store.js';

/** The same track reported again this soon is the same play (a retry, or a second tab). */
const SAME_PLAY_MS = 30_000;
/** A play can be reported late (offline, a retry), but not from the future or long ago. */
const LATEST_AHEAD_MS = 60_000;
const OLDEST_MS = 7 * 24 * 60 * 60_000;
/** Discover counts the last year of plays. */
const SEED_WINDOW_MS = 365 * 24 * 60 * 60_000;
/** ListenBrainz takes up to 100 listens per request. */
const BATCH = 100;
const SUBMIT_EVERY_MS = 5 * 60_000;

const tokenKey = (userId: number) => `listenbrainz-token:${userId}`;
const statusKey = (userId: number) => `listenbrainz-submit:${userId}`;
/** `afterPlay`: the newest play when the token was added; only later ones are submitted. */
const tokenSchema = z.object({ token: z.string(), userName: z.string(), afterPlay: z.number() });
const statusSchema = z.object({
  lastSubmittedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  /** ListenBrainz refused the token: stop until the user adds it again. */
  rejected: z.boolean().default(false),
});

/** Lidarr has no such track file (any more), or it is not on an album. */
export class PlayNotFound extends Error {}

export interface PlaysOptions {
  submitEveryMs?: number | null;
}

/**
 * Plays in Offbeat: recorded once the browser has listened long enough,
 * with details from Lidarr (never from the request), then used for Now
 * Playing's History and Discover's seeds, and submitted to ListenBrainz for
 * users who add their token. Submission runs in the background and retries.
 */
export class Plays {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly submitting = new Map<number, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly lidarr: () => LidarrClient | null,
    private readonly images: ImageUrls,
    private readonly listenbrainz: ListenBrainzClient,
    private readonly log: FastifyBaseLogger,
    private readonly options: PlaysOptions = {},
  ) {}

  start() {
    const every = this.options.submitEveryMs === undefined ? SUBMIT_EVERY_MS : this.options.submitEveryMs;
    if (every === null) return;
    this.timer = setInterval(() => void this.submitAll(), every);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Records a play of a Lidarr track file, started at `playedAt`. */
  async record(userId: number, trackFileId: number, playedAt: Date): Promise<void> {
    const now = Date.now();
    if (playedAt.getTime() > now + LATEST_AHEAD_MS || playedAt.getTime() < now - OLDEST_MS) {
      throw new RangeError('That play is from the future, or too long ago');
    }
    const duplicate = this.db
      .select({ id: plays.id })
      .from(plays)
      .where(
        and(
          eq(plays.userId, userId),
          eq(plays.trackFileId, trackFileId),
          gte(plays.playedAt, new Date(playedAt.getTime() - SAME_PLAY_MS)),
          sql`${plays.playedAt} <= ${Math.floor((playedAt.getTime() + SAME_PLAY_MS) / 1000)}`,
        ),
      )
      .get();
    if (duplicate) return;

    const lidarr = this.lidarr();
    if (!lidarr) throw new PlayNotFound('Connect Lidarr first');
    const file = await lidarr.trackFile(trackFileId).catch(() => null);
    if (!file?.albumId) throw new PlayNotFound('Lidarr has no such track file');
    const [album, tracks] = await Promise.all([lidarr.albumById(file.albumId), lidarr.tracks(file.albumId)]);
    const track = tracks.find((t) => t.trackFileId === trackFileId);
    if (!track) throw new PlayNotFound('Lidarr has no track for that file');

    this.db
      .insert(plays)
      .values({
        userId,
        trackFileId,
        title: track.title,
        artistName: album.artist?.artistName ?? 'Unknown artist',
        artistMbid: album.artist?.foreignArtistId ?? null,
        albumTitle: album.title,
        albumMbid: album.foreignAlbumId,
        recordingMbid: track.foreignRecordingId ?? null,
        durationMs: track.duration ?? null,
        mimeType: mimeTypeFor(file),
        playedAt,
      })
      .run();
    // Straight to ListenBrainz when the user submits there; the timer retries failures.
    void this.submit(userId);
  }

  /** What the user played, most recent first. */
  recent(userId: number, limit = 50): PlayedTrack[] {
    return this.db
      .select()
      .from(plays)
      .where(eq(plays.userId, userId))
      .orderBy(desc(plays.playedAt), desc(plays.id))
      .limit(limit)
      .all()
      .map((row) => ({
        trackFileId: row.trackFileId,
        mimeType: row.mimeType,
        title: row.title,
        artistName: row.artistName,
        artistMbid: row.artistMbid,
        albumTitle: row.albumTitle,
        albumMbid: row.albumMbid,
        coverUrl: row.albumMbid ? this.images.releaseGroupCover(row.albumMbid, { inLidarr: true }) : null,
        durationMs: row.durationMs,
        playedAt: row.playedAt.toISOString(),
      }));
  }

  /**
   * Plays per artist over the last year, for Discover. Plays already sent to
   * ListenBrainz are left out when ListenBrainz history is used too, since
   * ListenBrainz counts them there.
   */
  listened(userId: number, { skipSubmitted }: { skipSubmitted: boolean }): { mbid: string | null; name: string; plays: number }[] {
    const conditions = [eq(plays.userId, userId), gte(plays.playedAt, new Date(Date.now() - SEED_WINDOW_MS))];
    if (skipSubmitted) conditions.push(isNull(plays.listenbrainzAt));
    return this.db
      .select({ mbid: plays.artistMbid, name: plays.artistName, plays: sql<number>`count(*)` })
      .from(plays)
      .where(and(...conditions))
      .groupBy(plays.artistMbid, plays.artistName)
      .all();
  }

  // ListenBrainz ---------------------------------------------------------------

  submitView(userId: number): ListenBrainzSubmitView | null {
    const saved = this.settings.get(tokenKey(userId), tokenSchema);
    if (!saved) return null;
    const status = this.settings.get(statusKey(userId), statusSchema);
    const pending = this.db
      .select({ n: sql<number>`count(*)` })
      .from(plays)
      .where(and(eq(plays.userId, userId), isNull(plays.listenbrainzAt), gt(plays.id, saved.afterPlay)))
      .get();
    return {
      userName: saved.userName,
      lastSubmittedAt: status?.lastSubmittedAt ?? null,
      pending: pending?.n ?? 0,
      error: status?.error ?? null,
    };
  }

  /** Checks a ListenBrainz token and starts submitting plays from now on. Returns the ListenBrainz user. */
  async connect(userId: number, token: string): Promise<string> {
    const userName = await this.listenbrainz.validateToken(token);
    const newest = this.db.select({ id: sql<number>`coalesce(max(${plays.id}), 0)` }).from(plays).where(eq(plays.userId, userId)).get();
    this.settings.set(tokenKey(userId), { token, userName, afterPlay: newest?.id ?? 0 }, { encrypted: true });
    this.settings.delete(statusKey(userId));
    return userName;
  }

  disconnect(userId: number) {
    this.settings.delete(tokenKey(userId));
    this.settings.delete(statusKey(userId));
  }

  /** Submits every user's waiting plays (the background timer). */
  async submitAll(): Promise<void> {
    const rows = this.db.selectDistinct({ userId: plays.userId }).from(plays).where(isNull(plays.listenbrainzAt)).all();
    for (const { userId } of rows) await this.submit(userId);
  }

  /** Submits a user's waiting plays, a batch at a time. One run per user at once. */
  submit(userId: number): Promise<void> {
    const running = this.submitting.get(userId);
    if (running) return running;
    const run = this.submitWaiting(userId).finally(() => this.submitting.delete(userId));
    this.submitting.set(userId, run);
    return run;
  }

  private async submitWaiting(userId: number): Promise<void> {
    const saved = this.settings.get(tokenKey(userId), tokenSchema);
    if (!saved || this.settings.get(statusKey(userId), statusSchema)?.rejected) return;
    for (;;) {
      const waiting = this.db
        .select()
        .from(plays)
        .where(and(eq(plays.userId, userId), isNull(plays.listenbrainzAt), gt(plays.id, saved.afterPlay)))
        .orderBy(asc(plays.playedAt))
        .limit(BATCH)
        .all();
      if (!waiting.length) return;
      try {
        await this.listenbrainz.submitListens(
          saved.token,
          waiting.map((row) => ({
            listenedAt: row.playedAt,
            track: row.title,
            artist: row.artistName,
            release: row.albumTitle,
            recordingMbid: row.recordingMbid,
            releaseGroupMbid: row.albumMbid,
            artistMbid: row.artistMbid,
            durationMs: row.durationMs,
          })),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'ListenBrainz could not be reached';
        const rejected = error instanceof ListenBrainzTokenRejected;
        const lastSubmittedAt = this.settings.get(statusKey(userId), statusSchema)?.lastSubmittedAt ?? null;
        this.settings.set(statusKey(userId), { lastSubmittedAt, error: message, rejected }, { encrypted: false });
        this.log.warn({ userId, err: error }, 'ListenBrainz submission failed');
        return;
      }
      const now = new Date();
      this.db
        .update(plays)
        .set({ listenbrainzAt: now })
        .where(inArray(plays.id, waiting.map((row) => row.id)))
        .run();
      this.settings.set(statusKey(userId), { lastSubmittedAt: now.toISOString(), error: null, rejected: false }, { encrypted: false });
      if (waiting.length < BATCH) return;
    }
  }

}
