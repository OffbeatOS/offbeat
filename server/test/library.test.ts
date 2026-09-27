import type { LibraryResponse } from '@offbeat/shared';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { jobs } from '../src/db/schema.js';
import { LidarrClient } from '../src/integrations/lidarr/client.js';
import { type FakeLidarr, type FakeLidarrOptions, fakeArtists, startFakeLidarr } from './fake-lidarr.js';
import { tmpImageDir } from './helpers.js';

const fakes: FakeLidarr[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function fake(options: FakeLidarrOptions) {
  const lidarr = await startFakeLidarr(options);
  fakes.push(lidarr);
  return lidarr;
}

/** A signed-in admin with Lidarr pointed at `lidarr`, and the first sync done. */
async function libraryWith(lidarr: FakeLidarr) {
  const db = openDatabase(':memory:');
  const imageCacheDir = tmpImageDir();
  const app = await buildApp({
    config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
    db,
    secretKey: randomBytes(32),
    imageCacheDir,
    webRoot: null,
    logger: false,
    upstreamTimeoutMs: 300,
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'admin', password: randomBytes(12).toString('base64url') },
  });
  const cookie = `offbeat_session=${setup.cookies.find((c) => c.name === 'offbeat_session')?.value}`;
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
  await call('POST', '/setup/lidarr', {
    url: lidarr.url,
    apiKey: lidarr.apiKey,
    qualityProfileId: 2,
    metadataProfileId: 1,
    rootFolderPath: '/music',
  });
  await app.library.sync();
  return { app, db, call, imageCacheDir };
}

describe('library sync', () => {
  it('caches every artist with sort names, stats, and missing album counts', async () => {
    const lidarr = await fake({ artists: 30 });
    const { call } = await libraryWith(lidarr);
    const body = (await call('GET', '/library')).json<LibraryResponse>();

    expect(body.artists).toHaveLength(30);
    expect(body.sync).toMatchObject({ state: 'ok', error: null });
    const the = body.artists.find((a) => a.name.startsWith('The '));
    expect(the?.sortName).not.toMatch(/^the /);
    // Every fourth fake artist has 1 to 3 missing albums.
    expect(body.artists.find((a) => a.id === 1)?.missingAlbums).toBe(1);
    expect(body.artists.find((a) => a.id === 2)?.missingAlbums).toBe(0);
    expect(body.artists.find((a) => a.id === 5)?.missingAlbums).toBe(2);
  });

  it('pages through wanted/missing for large libraries', async () => {
    const lidarr = await fake({ artists: 5000 });
    const { call } = await libraryWith(lidarr);
    const body = (await call('GET', '/library')).json<LibraryResponse>();
    expect(body.artists).toHaveLength(5000);
    const totalMissing = body.artists.reduce((sum, a) => sum + a.missingAlbums, 0);
    // Every fourth fake artist has (index % 3) + 1 missing albums.
    const expected = fakeArtists(5000).reduce((sum, _a, i) => sum + (i % 4 === 0 ? (i % 3) + 1 : 0), 0);
    expect(totalMissing).toBe(expected);
    expect(lidarr.requests.filter((r) => r.includes('wanted/missing')).length).toBeGreaterThan(1);
  });

  it('keeps serving the cached library, with a readable error, when Lidarr goes away', async () => {
    const lidarr = await fake({ artists: 12 });
    const { call } = await libraryWith(lidarr);
    await lidarr.close();
    fakes.splice(fakes.indexOf(lidarr), 1);

    const body = (await call('POST', '/library/refresh', {})).json<LibraryResponse>();
    expect(body.artists).toHaveLength(12);
    expect(body.sync.state).toBe('error');
    expect(body.sync.error).toMatch(/Nothing is listening/);
    expect(body.sync.lastSyncedAt).not.toBeNull();
  });

  it('answers from cache immediately and refreshes stale data in the background', async () => {
    const lidarr = await fake({ artists: 3 });
    const { app, db, call } = await libraryWith(lidarr);
    const before = lidarr.requests.filter((r) => r.endsWith('/api/v1/artist')).length;

    // Fresh cache: no Lidarr call.
    await call('GET', '/library');
    expect(lidarr.requests.filter((r) => r.endsWith('/api/v1/artist')).length).toBe(before);

    // Age the cache past the threshold: the read still returns at once, and a sync starts.
    db.update(jobs).set({ lastRunAt: new Date(Date.now() - 10 * 60 * 1000) }).run();
    const res = (await call('GET', '/library')).json<LibraryResponse>();
    expect(res.artists).toHaveLength(3);
    expect(res.sync.state).toBe('syncing');
    await app.library.sync();
    expect(lidarr.requests.filter((r) => r.endsWith('/api/v1/artist')).length).toBe(before + 1);
  });

  it('is readable by any signed-in user, but not anonymously', async () => {
    const lidarr = await fake({ artists: 1 });
    const { app } = await libraryWith(lidarr);
    expect((await app.inject('/api/v1/library')).statusCode).toBe(401);
  });
});

describe('artwork proxy', () => {
  it('serves Lidarr artwork without exposing the key, and caches it on disk', async () => {
    const lidarr = await fake({ artists: 3 });
    const { call, imageCacheDir } = await libraryWith(lidarr);
    const { artists } = (await call('GET', '/library')).json<LibraryResponse>();
    const withArt = artists.find((a) => a.imageUrl)!;

    expect(withArt.imageUrl).toMatch(/^api\/v1\/images\/artist\/\d+\?v=[0-9a-f]{16}$/);
    expect(JSON.stringify(artists)).not.toContain(lidarr.apiKey);
    expect(JSON.stringify(artists)).not.toMatch(/MediaCover|127\.0\.0\.1/);

    const first = await call('GET', `/${withArt.imageUrl!.replace('api/v1/', '')}`);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.rawPayload.subarray(1, 4).toString()).toBe('PNG');

    // Lidarr's resized variant was requested, with the key in a header.
    expect(lidarr.requests.some((r) => /poster-250\.png/.test(r))).toBe(true);
    expect(lidarr.unauthenticated).toEqual([]);

    // Second request comes from disk, not Lidarr.
    const coverRequests = lidarr.requests.filter((r) => r.includes('MediaCover')).length;
    const second = await call('GET', `/${withArt.imageUrl!.replace('api/v1/', '')}`);
    expect(second.statusCode).toBe(200);
    expect(lidarr.requests.filter((r) => r.includes('MediaCover')).length).toBe(coverRequests);
    expect(readdirSync(imageCacheDir).some((f) => f.startsWith(`artist-${withArt.id}-`))).toBe(true);
  });

  it('reports no artwork for artists without any', async () => {
    const lidarr = await fake({ artists: 12 });
    const { call } = await libraryWith(lidarr);
    const { artists } = (await call('GET', '/library')).json<LibraryResponse>();
    const bare = artists.find((a) => a.imageUrl === null)!;
    expect(bare).toBeDefined();
    expect((await call('GET', `/images/artist/${bare.id}`)).statusCode).toBe(404);
  });

  it('needs a session', async () => {
    const lidarr = await fake({ artists: 2 });
    const { app } = await libraryWith(lidarr);
    expect((await app.inject('/api/v1/images/artist/2')).statusCode).toBe(401);
  });

  it('never sends the key outside Lidarr, even for a malformed image path', async () => {
    const lidarr = await fake({});
    const client = new LidarrClient({ url: lidarr.url, apiKey: lidarr.apiKey });
    for (const path of ['http://evil.example/MediaCover/x.jpg', '//evil.example/MediaCover/x.jpg', '/api/v1/system/status']) {
      await expect(client.mediaCover(path)).rejects.toThrow(/outside Lidarr/);
    }
    expect(lidarr.requests).toEqual([]);
  });
});
