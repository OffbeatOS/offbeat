import type { ActivitySnapshot, UserSummary } from '@offbeat/shared';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiRouteInfo } from '../src/api/index.js';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { blocklist, feedback, requests, users } from '../src/db/schema.js';
import { startFakeCatalog } from './fake-catalog.js';
import { tmpImageDir } from './helpers.js';

/** Fresh credentials per run; no real or shared passwords live in the tests. */
const password = () => randomBytes(12).toString('base64url');
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function setup(extra: { lidarrUrl?: string; apiKey?: string } = {}) {
  const routeTable: ApiRouteInfo[] = [];
  const app = await buildApp({
    config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
    db: openDatabase(':memory:'),
    secretKey: randomBytes(32),
    imageCacheDir: tmpImageDir(),
    webRoot: null,
    logger: false,
    activity: { autoStart: false },
    discovery: { schedule: null, feedbackRefreshMs: -1 },
    routeTable,
  });
  cleanup.push(() => app.close());
  const adminPassword = password();
  const res = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'boss', password: adminPassword } });
  const admin = cookieOf(res);
  const call = (cookie: string, method: Method, url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload || method !== 'GET' ? { payload: payload ?? {} } : {}) });
  if (extra.lidarrUrl) {
    await call(admin, 'POST', '/setup/lidarr', {
      url: extra.lidarrUrl,
      apiKey: extra.apiKey,
      qualityProfileId: 1,
      metadataProfileId: 1,
      rootFolderPath: '/music',
      addMonitored: false,
      searchOnAdd: false,
      addTag: 'offbeat-test',
    });
  }
  /** Creates a user through the API and signs them in. */
  const member = async (username: string, permissions: string[] = [], role = 'user') => {
    const pw = password();
    const created = await call(admin, 'POST', '/users', { username, password: pw, role, permissions });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: pw } });
    return { id: created.json<UserSummary>().id, cookie: cookieOf(login), password: pw };
  };
  return { app, admin, call, member, routeTable, adminPassword };
}

function cookieOf(res: { cookies: { name: string; value: string }[] }) {
  const cookie = res.cookies.find((c) => c.name === 'offbeat_session');
  if (!cookie) throw new Error('no session cookie');
  return `offbeat_session=${cookie.value}`;
}

const MBID = '00000000-0000-4000-8000-000000000001';

/**
 * Routes any signed-in user may call: reading, and their own Discover,
 * feedback, blocklist, and listening accounts. Everything else must be
 * public, admin only, or need a permission. A new route fails the audit
 * below until it is classified.
 */
const ANY_SIGNED_IN = new Set([
  'GET /activity',
  'GET /events',
  'GET /search',
  'GET /artists/:mbid',
  'GET /albums/:mbid',
  'GET /library',
  'POST /library/refresh',
  'GET /images/artist/:id',
  'GET /images/album/:mbid',
  'GET /images/remote',
  'GET /discover',
  'POST /discover/refresh',
  'GET /discover/status',
  'GET /discover/preferences',
  'PUT /discover/preferences',
  'POST /discover/feedback',
  'GET /blocklist',
  'POST /blocklist',
  'DELETE /blocklist/:id',
  'GET /tags/:tag',
  'GET /account',
  'PUT /account/listening',
]);

describe('route audit', () => {
  it('every API route is public, admin only, needs a permission, or is deliberately open to any signed-in user', async () => {
    const { routeTable } = await setup();
    const unclassified = routeTable
      .map((r) => ({ ...r, key: `${r.method} ${r.url.replace(/^\/api\/v1/, '')}` }))
      .filter((r) => !r.config.public && !r.config.role && !r.config.permission && !ANY_SIGNED_IN.has(r.key))
      .map((r) => r.key);
    expect(unclassified).toEqual([]);
    // And the list above names no route that is gone.
    const keys = new Set(routeTable.map((r) => `${r.method} ${r.url.replace(/^\/api\/v1/, '')}`));
    expect([...ANY_SIGNED_IN].filter((k) => !keys.has(k))).toEqual([]);
  });
});

describe('permissions', () => {
  it('a Member without permissions is refused every write the server guards, called directly', async () => {
    const { call, member } = await setup();
    const { cookie } = await member('reader');
    const forbidden: [Method, string, object?][] = [
      ['POST', `/artists/${MBID}`],
      ['POST', `/albums/${MBID}`, { artistMbid: MBID }],
      ['PATCH', `/artists/${MBID}`, { monitored: true }],
      ['PATCH', `/albums/${MBID}`, { monitored: true }],
      ['POST', `/albums/${MBID}/search`],
      ['POST', '/activity/queue:1/retry'],
      ['DELETE', '/activity/queue:1'],
      ['GET', '/users'],
      ['POST', '/users', { username: 'sneaky', password: password(), role: 'admin', permissions: [] }],
      ['PATCH', '/users/1', { role: 'user' }],
      ['DELETE', '/users/1'],
      ['POST', '/users/1/password', { password: password() }],
      ['GET', '/settings/lidarr'],
      ['PUT', '/settings/lidarr', {}],
      ['GET', '/settings/lastfm'],
      ['DELETE', '/settings/lastfm'],
    ];
    for (const [method, url, body] of forbidden) {
      const res = await call(cookie, method, url, body);
      expect([method, url, res.statusCode]).toEqual([method, url, 403]);
    }
    // Reading and their own Discover still work.
    expect((await call(cookie, 'GET', '/discover/preferences')).statusCode).toBe(200);
    expect((await call(cookie, 'GET', '/blocklist')).statusCode).toBe(200);
  });

  it('a granted permission lets the request through to the handler, and changes apply without signing in again', async () => {
    const { call, admin, member } = await setup();
    const bob = await member('bob', ['add-artists']);
    // Past the guard: Lidarr is not connected, so the handler answers 409.
    expect((await call(bob.cookie, 'POST', `/artists/${MBID}`)).statusCode).toBe(409);
    expect((await call(bob.cookie, 'POST', `/albums/${MBID}`, { artistMbid: MBID })).statusCode).toBe(403);

    await call(admin, 'PATCH', `/users/${bob.id}`, { permissions: ['add-albums'] });
    expect((await call(bob.cookie, 'POST', `/artists/${MBID}`)).statusCode).toBe(403);
    const me = await call(bob.cookie, 'GET', '/auth/me');
    expect(me.json()).toMatchObject({ user: { username: 'bob', role: 'user', permissions: ['add-albums'] } });
  });

  it('admins have every permission, whatever is stored', async () => {
    const { call, admin } = await setup();
    const me = await call(admin, 'GET', '/auth/me');
    expect(me.json().user.permissions).toEqual(['add-artists', 'add-albums', 'change-monitoring', 'delete', 'flows']);
  });
});

describe('managing users', () => {
  it('adds users, refuses a taken name in any case, and validates input', async () => {
    const { call, admin } = await setup();
    const res = await call(admin, 'POST', '/users', { username: 'Robin', password: password(), role: 'user', permissions: ['add-albums', 'add-artists'] });
    expect(res.json()).toMatchObject({ username: 'Robin', role: 'user', permissions: ['add-artists', 'add-albums'] });
    expect((await call(admin, 'POST', '/users', { username: 'robin', password: password(), role: 'user', permissions: [] })).statusCode).toBe(409);
    expect((await call(admin, 'POST', '/users', { username: 'x', password: password(), role: 'user', permissions: [] })).statusCode).toBe(400);
    expect((await call(admin, 'POST', '/users', { username: 'kim', password: 'short', role: 'user', permissions: [] })).statusCode).toBe(400);
    expect((await call(admin, 'POST', '/users', { username: 'kim', password: password(), role: 'owner', permissions: [] })).statusCode).toBe(400);
    expect((await call(admin, 'POST', '/users', { username: 'kim', password: password(), role: 'user', permissions: ['root'] })).statusCode).toBe(400);
    expect((await call(admin, 'GET', '/users')).json<UserSummary[]>().map((u) => u.username)).toEqual(['boss', 'Robin']);
  });

  it('never demotes or removes the last admin, and nobody removes themselves', async () => {
    const { call, admin, member, app } = await setup();
    const bossId = app.db.select().from(users).get()!.id;
    expect((await call(admin, 'PATCH', `/users/${bossId}`, { role: 'user' })).statusCode).toBe(409);
    expect((await call(admin, 'DELETE', `/users/${bossId}`)).statusCode).toBe(409);

    // With a second admin, one can step down, but the last one left still cannot.
    const second = await member('deputy', [], 'admin');
    expect((await call(admin, 'PATCH', `/users/${bossId}`, { role: 'user' })).statusCode).toBe(200);
    expect((await call(second.cookie, 'PATCH', `/users/${second.id}`, { role: 'user' })).statusCode).toBe(409);
    expect((await call(second.cookie, 'DELETE', `/users/${second.id}`)).statusCode).toBe(409);
    // The demoted admin lost admin rights at once.
    expect((await call(admin, 'GET', '/users')).statusCode).toBe(403);
  });

  it('resets a password: the new one works, the old one does not, and old sessions end', async () => {
    const { call, admin, member, app } = await setup();
    const bob = await member('bob');
    const fresh = password();
    expect((await call(admin, 'POST', `/users/${bob.id}/password`, { password: fresh })).statusCode).toBe(204);
    expect((await call(bob.cookie, 'GET', '/discover/preferences')).statusCode).toBe(401);
    const login = (pw: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'bob', password: pw } });
    expect((await login(bob.password)).statusCode).toBe(401);
    expect((await login(fresh)).statusCode).toBe(200);
  });

  it('an admin resetting their own password stays signed in here', async () => {
    const { call, admin, app } = await setup();
    const bossId = app.db.select().from(users).get()!.id;
    expect((await call(admin, 'POST', `/users/${bossId}/password`, { password: password() })).statusCode).toBe(204);
    expect((await call(admin, 'GET', '/users')).statusCode).toBe(200);
  });

  it('removing a user signs them out and drops their own Discover data, but keeps their name on requests', async () => {
    const { call, admin, member, app } = await setup();
    const bob = await member('bob', ['add-albums']);
    app.db.insert(requests).values({ userId: bob.id, requestedBy: 'bob', artistMbid: MBID, albumMbid: MBID, lidarrAlbumId: 5 }).run();
    app.db.insert(feedback).values({ userId: bob.id, artistMbid: MBID, name: 'X', value: -1, genres: '[]' }).run();
    app.db.insert(blocklist).values({ userId: bob.id, kind: 'tag', key: 'pop', name: 'Pop', source: 'settings' }).run();

    expect((await call(admin, 'DELETE', `/users/${bob.id}`)).statusCode).toBe(204);
    expect((await call(bob.cookie, 'GET', '/discover/preferences')).statusCode).toBe(401);
    expect(app.db.select().from(requests).all()).toMatchObject([{ userId: null, requestedBy: 'bob' }]);
    expect(app.db.select().from(feedback).all()).toEqual([]);
    expect(app.db.select().from(blocklist).all()).toEqual([]);
    expect((await call(admin, 'DELETE', `/users/${bob.id}`)).statusCode).toBe(404);
  });

  it('shows who asked in Activity, even after that user is removed', async () => {
    const fake = await startFakeCatalog();
    cleanup.push(() => fake.close());
    const { call, admin, member, app } = await setup({ lidarrUrl: fake.lidarrUrl, apiKey: fake.apiKey });
    const bob = await member('bob', ['add-albums']);
    app.db.insert(requests).values({ userId: bob.id, requestedBy: 'bob', artistMbid: MBID, albumMbid: MBID, lidarrAlbumId: 5 }).run();
    fake.queue.push({ id: 1, albumId: 5, album: { title: 'Geogaddi', foreignAlbumId: MBID }, status: 'downloading', trackedDownloadState: 'downloading', size: 10, sizeleft: 5 });
    await call(admin, 'DELETE', `/users/${bob.id}`);
    await app.activity.refresh();
    const snap = (await call(admin, 'GET', '/activity')).json<ActivitySnapshot>();
    expect(snap.inProgress[0]?.source).toBe('requested by bob');
  });
});
