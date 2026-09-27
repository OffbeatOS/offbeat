import type { ActivitySnapshot } from '@offbeat/shared';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { describeQueueItem, formatTimeLeft, queueMessages, queueState } from '../src/activity/mapping.js';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { WORLD, startFakeCatalog } from './fake-catalog.js';
import { tmpImageDir } from './helpers.js';

const BOC = WORLD[0]!;
const GEOGADDI = BOC.albums[1]!;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

/** Queue records shaped like the real ones from a Lidarr v3 queue. */
function queueRecord(extra: Record<string, unknown>) {
  return {
    id: 101,
    albumId: null,
    artistId: null,
    album: { title: 'Geogaddi', foreignAlbumId: GEOGADDI.mbid },
    artist: { artistName: 'Boards of Canada', foreignArtistId: BOC.mbid },
    title: 'Boards.of.Canada-Geogaddi-FLAC',
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    statusMessages: [],
    errorMessage: '',
    size: 400_000_000,
    sizeleft: 100_000_000,
    timeleft: '00:03:10',
    ...extra,
  };
}

const IMPORT_FAILED = {
  status: 'completed',
  trackedDownloadStatus: 'warning',
  trackedDownloadState: 'importFailed',
  sizeleft: 0,
  statusMessages: [
    { title: 'One or more tracks expected in this release were not imported or missing from the release', messages: [] },
    { title: '06-frank_turner-scavenger_type.flac', messages: ['Album match is not close enough: 73.4 % vs 80 % [artist, missing tracks]', 'Has missing tracks'] },
    { title: '07-frank_turner-bob.flac', messages: ['Album match is not close enough: 73.4 % vs 80 % [artist, missing tracks]', 'Has missing tracks'] },
  ],
};

async function setup(
  options: {
    activeMs?: number;
    watchedIdleMs?: number;
    burstMs?: number;
    historyEveryMs?: number;
    pollTimeoutMs?: number;
    autoStart?: boolean;
  } = {},
) {
  const fake = await startFakeCatalog();
  const app = await buildApp({
    config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
    db: openDatabase(':memory:'),
    secretKey: randomBytes(32),
    imageCacheDir: tmpImageDir(),
    webRoot: null,
    logger: false,
    upstreamTimeoutMs: 2000,
    musicbrainz: { url: fake.musicbrainzUrl, minTimeMs: 0 },
    catalog: { pollMs: 50, albumAppearTimeoutMs: 3000 },
    activity: {
      autoStart: options.autoStart ?? false,
      activeMs: options.activeMs ?? 40,
      watchedIdleMs: options.watchedIdleMs ?? 10_000,
      unwatchedMs: 10_000,
      burstMs: options.burstMs ?? 0,
      historyEveryMs: options.historyEveryMs ?? 30_000,
      pollTimeoutMs: options.pollTimeoutMs ?? 45_000,
    },
  });
  cleanup.push(() => app.close(), () => fake.close());
  const setupRes = await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'sam', password: randomBytes(12).toString('base64url') },
  });
  const cookie = `offbeat_session=${setupRes.cookies.find((c) => c.name === 'offbeat_session')?.value}`;
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
  await call('POST', '/setup/lidarr', {
    url: fake.lidarrUrl,
    apiKey: fake.apiKey,
    qualityProfileId: 1,
    metadataProfileId: 1,
    rootFolderPath: '/music',
    addMonitored: false,
    searchOnAdd: false,
    addTag: 'offbeat-test',
  });
  await app.library.sync();
  return { app, fake, call, cookie };
}

async function snapshot(call: Awaited<ReturnType<typeof setup>>['call'], app: Awaited<ReturnType<typeof setup>>['app']) {
  await app.activity.refresh();
  return (await call('GET', '/activity')).json<ActivitySnapshot>();
}

describe('mapping Lidarr queue records', () => {
  it.each([
    [{ status: 'downloading', trackedDownloadState: 'downloading' }, 'downloading'],
    [{ status: 'queued', trackedDownloadState: 'downloading' }, 'queued'],
    [{ status: 'paused', trackedDownloadState: 'downloading' }, 'paused'],
    [{ status: 'completed', trackedDownloadState: 'importPending' }, 'importing'],
    [{ status: 'completed', trackedDownloadState: 'importFailed' }, 'import-blocked'],
    [{ status: 'completed', trackedDownloadState: 'importBlocked' }, 'import-blocked'],
    [{ status: 'failed', trackedDownloadState: 'downloadFailed' }, 'failed'],
    [{ status: 'warning', trackedDownloadState: 'downloadFailedPending' }, 'failed'],
  ])('%j is %s', (item, state) => {
    expect(queueState(item)).toBe(state);
  });

  it('turns an import failure into a plain reason, with Lidarr messages deduplicated', () => {
    const described = describeQueueItem(queueRecord(IMPORT_FAILED) as never);
    expect(described.state).toBe('import-blocked');
    expect(described.reason).toMatch(/did not match the album closely enough/);
    expect(queueMessages(queueRecord(IMPORT_FAILED) as never)).toEqual([
      'One or more tracks expected in this release were not imported or missing from the release',
      'Album match is not close enough: 73.4 % vs 80 % [artist, missing tracks]',
      'Has missing tracks',
    ]);
    expect(described.canRetry).toBe(true);
  });

  it('shows progress and time left while downloading', () => {
    const described = describeQueueItem(queueRecord({}) as never);
    expect(described).toMatchObject({ state: 'downloading', progress: 0.75, detail: '75%, about 3 min left', canCancel: true });
    expect(formatTimeLeft('1.02:00:00')).toBe('about 26 hours left');
    expect(formatTimeLeft('00:00:20')).toBe('less than a minute left');
  });
});

describe('activity snapshot', () => {
  it('splits items into needs attention and in progress, and credits Lidarr adds to Lidarr', async () => {
    const { app, fake, call } = await setup();
    fake.queue.push(queueRecord({ id: 1 }), queueRecord({ id: 2, ...IMPORT_FAILED }));
    const snap = await snapshot(call, app);

    expect(snap.inProgress.map((i) => [i.id, i.state, i.source])).toEqual([['queue:1', 'downloading', 'Added in Lidarr']]);
    expect(snap.attention).toHaveLength(1);
    expect(snap.attention[0]).toMatchObject({
      id: 'queue:2',
      state: 'import-blocked',
      canRetry: true,
      lidarrLink: `${fake.lidarrUrl}/activity/queue`,
    });
    // Queue items are albums Lidarr has, so their covers come from Lidarr's local copy first.
    expect(snap.inProgress[0]?.coverUrl).toMatch(/^api\/v1\/images\/album\/[0-9a-f-]{36}\?src=lidarr$/);
  });

  it('credits adds made through Offbeat to the user who asked', async () => {
    const { app, fake, call } = await setup();
    await app.catalog.addAlbum(GEOGADDI.mbid, BOC.mbid, 1);
    const albumId = [...fake.library.values()][0]!.albums.find((a) => a.title === 'Geogaddi')!.id;
    fake.queue.push(queueRecord({ id: 3, albumId }));
    const snap = await snapshot(call, app);
    expect(snap.inProgress[0]?.source).toBe('requested by sam');
  });

  it('shows albums Lidarr is still searching for', async () => {
    const { app, fake, call } = await setup();
    await app.catalog.addAlbum(GEOGADDI.mbid, BOC.mbid, 1);
    await call('POST', `/albums/${GEOGADDI.mbid}/search`, {});
    const snap = await snapshot(call, app);
    expect(snap.inProgress.find((i) => i.state === 'searching')).toMatchObject({
      albumTitle: 'Geogaddi',
      detail: 'Checking indexers',
    });
    expect(fake.commands.map((c) => c.name)).toContain('AlbumSearch');
  });

  it('lists recent imports as completed', async () => {
    const { app, fake, call } = await setup();
    fake.history.push({
      id: 9,
      eventType: 'downloadImported',
      date: '2026-09-27T05:44:35Z',
      album: { title: 'Geogaddi', foreignAlbumId: GEOGADDI.mbid },
      artist: { artistName: 'Boards of Canada', foreignArtistId: BOC.mbid },
    });
    const snap = await snapshot(call, app);
    expect(snap.completed).toMatchObject([{ albumTitle: 'Geogaddi', date: '2026-09-27T05:44:35Z', source: 'Added in Lidarr' }]);
  });
});

describe('retry and cancel', () => {
  it('retry blocklists the release, skips Lidarr re-grab, and searches again', async () => {
    const { app, fake, call } = await setup();
    fake.queue.push(queueRecord({ id: 7, albumId: 55, ...IMPORT_FAILED }));
    await snapshot(call, app);
    expect((await call('POST', '/activity/queue:7/retry', {})).statusCode).toBe(202);
    expect(fake.removals).toEqual([{ id: 7, blocklist: true, skipRedownload: true }]);
    expect(fake.commands).toEqual([{ name: 'AlbumSearch', albumIds: [55] }]);
  });

  it('cancel removes without blocklisting', async () => {
    const { fake, call } = await setup();
    fake.queue.push(queueRecord({ id: 8 }));
    expect((await call('DELETE', '/activity/queue:8', {})).statusCode).toBe(202);
    expect(fake.removals).toEqual([{ id: 8, blocklist: false, skipRedownload: true }]);
    expect(fake.commands).toEqual([]);
  });

  it('404s items that are gone, and rejects malformed ids', async () => {
    const { call } = await setup();
    expect((await call('POST', '/activity/queue:999/retry', {})).statusCode).toBe(404);
    expect((await call('POST', '/activity/../../etc/retry', {})).statusCode).toBe(404);
    expect((await call('POST', '/activity/bogus/retry', {})).statusCode).toBe(400);
  });

  it('shows a failed background add under needs attention, and retries it', async () => {
    const { app, call } = await setup();
    // An artist the fake Lidarr has never heard of: the add fails.
    const unknownArtist = '00000000-0000-4000-8000-00000000abcd';
    const failed = new Promise<void>((resolve) => {
      const off = app.activity.subscribe((e) => {
        if (e.type === 'add-result' && !e.data.ok) {
          off();
          resolve();
        }
      });
    });
    expect((await call('POST', `/albums/${GEOGADDI.mbid}`, { artistMbid: unknownArtist })).statusCode).toBe(202);
    await failed;
    const snap = await snapshot(call, app);
    expect(snap.attention[0]).toMatchObject({ id: `add:${GEOGADDI.mbid}`, state: 'failed', canRetry: true });
    expect(snap.attention[0]?.reason).toBeTruthy();
    expect((await call('POST', `/activity/add:${GEOGADDI.mbid}/retry`, {})).statusCode).toBe(202);
  });
});

describe('polling', () => {
  it('polls quickly only while something is moving and someone is watching', async () => {
    const { app, fake } = await setup({ activeMs: 30, watchedIdleMs: 10_000 });
    app.activity.start();
    const off = app.activity.subscribe(() => undefined);
    const count = () => fake.hits.filter((h) => h === 'queue').length;

    await new Promise((r) => setTimeout(r, 600));
    const idle = count();
    expect(idle).toBeLessThanOrEqual(2); // nothing moving: one poll on subscribe, then the slow interval

    fake.queue.push(queueRecord({ id: 1 }));
    await app.activity.wake();
    const before = count();
    await new Promise((r) => setTimeout(r, 600));
    // Downloading: polls back to back at the active interval, several times the idle rate.
    expect(count() - before).toBeGreaterThanOrEqual(idle + 3);
    off();
  });

  /** Resolves once the published snapshot has something in progress, or false after `ms`. */
  function seesDownload(app: Awaited<ReturnType<typeof setup>>['app'], ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, ms);
      const off = app.activity.subscribe((e) => {
        if (e.type === 'activity' && e.data.inProgress.length > 0) {
          clearTimeout(timer);
          off();
          resolve(true);
        }
      });
    });
  }

  it('polls quickly for a while after a search, so a quick download is not missed', async () => {
    const { app, fake } = await setup({ activeMs: 20, watchedIdleMs: 10_000, burstMs: 400 });
    app.activity.start();
    const off = app.activity.subscribe(() => undefined);
    await app.activity.refresh();

    await app.activity.expectMovement();
    fake.queue.push(queueRecord({ id: 1 })); // grabbed after the search, between idle polls
    expect(await seesDownload(app, 1000)).toBe(true);

    // Once the window has passed with nothing moving, polling is slow again.
    fake.queue.length = 0;
    await app.activity.wake();
    await new Promise((r) => setTimeout(r, 600));
    fake.queue.push(queueRecord({ id: 2 }));
    expect(await seesDownload(app, 500)).toBe(false);
    off();
  });

  it('starts polling on its own once the app is ready', async () => {
    const { app, fake } = await setup({ autoStart: true, watchedIdleMs: 50 });
    const off = app.activity.subscribe(() => undefined);
    const before = fake.hits.filter((h) => h === 'queue').length;
    await new Promise((r) => setTimeout(r, 500));
    // Nobody called start(): the loop is running anyway, several polls later.
    expect(fake.hits.filter((h) => h === 'queue').length - before).toBeGreaterThanOrEqual(3);
    off();
  });

  it('survives the database closing under it during shutdown', async () => {
    const db = openDatabase(':memory:');
    const app = await buildApp({
      config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
      db,
      secretKey: randomBytes(32),
      imageCacheDir: tmpImageDir(),
      webRoot: null,
      logger: false,
      activity: { watchedIdleMs: 20, unwatchedMs: 20 },
    });
    await app.ready(); // polling starts on its own
    db.$client.close();
    // Polls keep firing against the closed database; none may escape as an error.
    await expect(app.activity.refresh()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 100));
    await app.close();
  });

  it('abandons a poll Lidarr never answers, says so, and keeps polling', async () => {
    const { app, fake } = await setup({ activeMs: 20, watchedIdleMs: 50, pollTimeoutMs: 200 });
    app.activity.start();
    const off = app.activity.subscribe(() => undefined);
    await app.activity.refresh();

    fake.stallQueue = true;
    await app.activity.refresh(); // resolves once abandoned, instead of hanging forever
    expect(app.activity.current().error).toMatch(/taking too long/);

    fake.stallQueue = false;
    fake.queue.push(queueRecord({ id: 3 }));
    expect(await seesDownload(app, 1500)).toBe(true);
    expect(app.activity.current().error).toBeNull();
    off();
  });

  it('notices a grab started in Lidarr itself and polls quickly', async () => {
    const { app, fake } = await setup({ activeMs: 20, watchedIdleMs: 10_000, burstMs: 2000, historyEveryMs: 0 });
    fake.history.push({ id: 1, eventType: 'grabbed', date: '2026-09-27T05:00:00Z', sourceTitle: 'Old grab' });
    app.activity.start();
    const off = app.activity.subscribe(() => undefined);
    await app.activity.refresh();

    // A grab from before Offbeat started does not speed anything up.
    await app.activity.wake();
    fake.queue.push(queueRecord({ id: 1 }));
    expect(await seesDownload(app, 500)).toBe(false);
    fake.queue.length = 0;

    // A new grab, seen on the next regular poll (stood in for by wake), opens the fast window.
    fake.history.unshift({ id: 2, eventType: 'grabbed', date: '2026-09-27T06:12:53Z', sourceTitle: 'In a Beautiful Place' });
    await app.activity.wake();
    fake.queue.push(queueRecord({ id: 2 }));
    expect(await seesDownload(app, 1000)).toBe(true);
    off();
  });
});

describe('server-sent events', () => {
  it('streams the snapshot, then pushes changes', async () => {
    const { app, fake, cookie } = await setup();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/v1/events`, { headers: { cookie }, signal: controller.signal });
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextEvent = async (): Promise<{ event: string; data: unknown }> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (event && data) return { event, data: JSON.parse(data) };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    };

    const first = await nextEvent();
    expect(first.event).toBe('activity');

    fake.queue.push(queueRecord({ id: 42 }));
    await app.activity.wake();
    let pushed = await nextEvent();
    while ((pushed.data as ActivitySnapshot).inProgress.length === 0) pushed = await nextEvent();
    expect((pushed.data as ActivitySnapshot).inProgress[0]).toMatchObject({ id: 'queue:42', state: 'downloading' });
    controller.abort();
  });

  it('needs a session', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/v1/events')).statusCode).toBe(401);
  });
});
