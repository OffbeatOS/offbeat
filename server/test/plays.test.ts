import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretBox } from '../src/crypto/secret-box.js';
import { openDatabase } from '../src/db/index.js';
import { plays, users } from '../src/db/schema.js';
import type { LidarrClient } from '../src/integrations/lidarr/client.js';
import { ListenBrainzClient, ListenBrainzTokenRejected } from '../src/integrations/listenbrainz/client.js';
import { ImageUrls } from '../src/library/image-urls.js';
import { PlayNotFound, Plays } from '../src/listening/plays.js';
import { SettingsStore } from '../src/settings/store.js';
import { type FakeListening, startFakeListening } from './fake-listening.js';

const silentLog = { debug() {}, info() {}, warn() {} } as unknown as FastifyBaseLogger;
const TOKEN = '11111111-2222-4333-8444-555555555555';
const NOFX = 'dcaa4f81-bfb7-44eb-8594-4e74f004b6e4';
const DRUBLIC = 'e45567d0-0c20-3936-a49f-1b42901f89fd';

const fakes: FakeListening[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

/** Punk in Drublic in Lidarr: two tracks with files (198 and 199). */
const lidarr = {
  trackFile: vi.fn(async (id: number) => {
    if (id !== 198 && id !== 199) throw new Error('404');
    return { id, albumId: 38, path: `/music/NOFX/Punk in Drublic (1994)/${id}.flac`, mediaInfo: { audioCodec: 'FLAC' } };
  }),
  albumById: vi.fn(async () => ({ id: 38, title: 'Punk in Drublic', foreignAlbumId: DRUBLIC, artist: { artistName: 'NOFX', foreignArtistId: NOFX } })),
  tracks: vi.fn(async () => [
    { id: 1, title: 'Linoleum', duration: 130_000, trackFileId: 198, foreignRecordingId: 'rec-linoleum' },
    { id: 2, title: 'Leave It Alone', duration: 124_000, trackFileId: 199, foreignRecordingId: 'rec-leave' },
  ]),
} as unknown as LidarrClient;

async function setup() {
  const fake = await startFakeListening();
  fakes.push(fake);
  const db = openDatabase(':memory:');
  const userId = db.insert(users).values({ username: 'sam', passwordHash: 'x' }).returning().get().id;
  const settings = new SettingsStore(db, new SecretBox(randomBytes(32)));
  const listenbrainz = new ListenBrainzClient({ url: fake.listenbrainzUrl });
  const service = new Plays(db, settings, () => lidarr, new ImageUrls(randomBytes(32)), listenbrainz, silentLog, { submitEveryMs: null });
  return { fake, db, userId, settings, service };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('recording plays', () => {
  it('takes the details from Lidarr, not the request, and lists what was played, newest first', async () => {
    const { service, userId } = await setup();
    await service.record(userId, 198, minutesAgo(5));
    await service.record(userId, 199, minutesAgo(3));
    const recent = service.recent(userId);
    expect(recent.map((p) => [p.title, p.artistName, p.albumTitle])).toEqual([
      ['Leave It Alone', 'NOFX', 'Punk in Drublic'],
      ['Linoleum', 'NOFX', 'Punk in Drublic'],
    ]);
    expect(recent[0]).toMatchObject({ trackFileId: 199, mimeType: 'audio/flac', durationMs: 124_000, albumMbid: DRUBLIC, artistMbid: NOFX });
    expect(recent[0]!.coverUrl).toContain(DRUBLIC);
  });

  it('counts the same play once, however often it is reported', async () => {
    const { service, userId } = await setup();
    const at = minutesAgo(2);
    await service.record(userId, 198, at);
    await service.record(userId, 198, new Date(at.getTime() + 10_000));
    expect(service.recent(userId)).toHaveLength(1);
    // Played again later: a second play.
    await service.record(userId, 198, new Date(at.getTime() + 131_000));
    expect(service.recent(userId)).toHaveLength(2);
  });

  it('refuses plays from the future or long ago, and track files Lidarr does not have', async () => {
    const { service, userId } = await setup();
    await expect(service.record(userId, 198, new Date(Date.now() + 10 * 60_000))).rejects.toThrow(RangeError);
    await expect(service.record(userId, 198, minutesAgo(8 * 24 * 60))).rejects.toThrow(RangeError);
    await expect(service.record(userId, 500, minutesAgo(1))).rejects.toThrow(PlayNotFound);
  });

  it('counts plays per artist for Discover, leaving out ones ListenBrainz already has when asked', async () => {
    const { service, userId, db } = await setup();
    await service.record(userId, 198, minutesAgo(10));
    await service.record(userId, 199, minutesAgo(5));
    expect(service.listened(userId, { skipSubmitted: false })).toEqual([{ mbid: NOFX, name: 'NOFX', plays: 2 }]);
    db.update(plays).set({ listenbrainzAt: new Date() }).run();
    expect(service.listened(userId, { skipSubmitted: true })).toEqual([]);
    expect(service.listened(userId, { skipSubmitted: false })).toEqual([{ mbid: NOFX, name: 'NOFX', plays: 2 }]);
  });
});

describe('submitting to ListenBrainz', () => {
  it('checks the token, then submits plays from then on with their MusicBrainz ids', async () => {
    const { service, userId, fake } = await setup();
    await service.record(userId, 198, minutesAgo(30)); // before connecting: never submitted
    await expect(service.connect(userId, '99999999-2222-4333-8444-555555555555')).rejects.toThrow(ListenBrainzTokenRejected);
    expect(service.submitView(userId)).toBeNull();

    expect(await service.connect(userId, TOKEN)).toBe('sam_lb');
    const playedAt = minutesAgo(2);
    await service.record(userId, 199, playedAt);
    await service.submit(userId);

    expect(fake.submitted).toHaveLength(1);
    expect(fake.submitted[0]!.token).toBe(TOKEN);
    expect(fake.submitted[0]!.body).toEqual({
      listen_type: 'single',
      payload: [
        {
          listened_at: Math.floor(playedAt.getTime() / 1000),
          track_metadata: {
            artist_name: 'NOFX',
            track_name: 'Leave It Alone',
            release_name: 'Punk in Drublic',
            additional_info: expect.objectContaining({
              recording_mbid: 'rec-leave',
              release_group_mbid: DRUBLIC,
              artist_mbids: [NOFX],
              duration_ms: 124_000,
              media_player: 'Offbeat',
              submission_client: 'Offbeat',
            }),
          },
        },
      ],
    });
    expect(service.submitView(userId)).toMatchObject({ userName: 'sam_lb', pending: 0, error: null, lastSubmittedAt: expect.any(String) });
  });

  it('keeps plays while ListenBrainz is down, and sends them together once it is back', async () => {
    const { service, userId, fake } = await setup();
    await service.connect(userId, TOKEN);
    fake.submitStatus.code = 503;
    await service.record(userId, 198, minutesAgo(4));
    await service.record(userId, 199, minutesAgo(2));
    await service.submit(userId);
    expect(service.submitView(userId)).toMatchObject({ pending: 2, error: expect.stringContaining('503') });

    fake.submitStatus.code = 200;
    await service.submitAll();
    expect(fake.submitted.at(-1)!.body.listen_type).toBe('import');
    expect(fake.submitted.at(-1)!.body.payload.map((p) => p.track_metadata.track_name)).toEqual(['Linoleum', 'Leave It Alone']);
    expect(service.submitView(userId)).toMatchObject({ pending: 0, error: null });
  });

  it('stops when ListenBrainz no longer takes the token, until it is added again', async () => {
    const { service, userId, fake } = await setup();
    await service.connect(userId, TOKEN);
    fake.listenbrainzTokens.clear(); // reset on ListenBrainz
    await service.record(userId, 198, minutesAgo(1));
    await service.submit(userId);
    expect(service.submitView(userId)?.error).toContain('no longer accepts the token');
    const tries = fake.requests.filter((r) => r.includes('submit-listens')).length;
    await service.submitAll();
    expect(fake.requests.filter((r) => r.includes('submit-listens')).length).toBe(tries);

    service.disconnect(userId);
    expect(service.submitView(userId)).toBeNull();
  });
});
