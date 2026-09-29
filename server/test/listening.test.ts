import type { AccountView, LastfmSettingsView } from '@offbeat/shared';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { createSession } from '../src/auth/sessions.js';
import { settings, users } from '../src/db/schema.js';
import { LASTFM_KEY, startFakeListening } from './fake-listening.js';
import { tmpImageDir } from './helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function setup() {
  const fake = await startFakeListening();
  const db = openDatabase(':memory:');
  const app = await buildApp({
    config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
    db,
    secretKey: randomBytes(32),
    imageCacheDir: tmpImageDir(),
    webRoot: null,
    logger: false,
    upstreamTimeoutMs: 2000,
    activity: { autoStart: false },
    sources: { lastfmUrl: fake.lastfmUrl, listenbrainzUrl: fake.listenbrainzUrl },
  });
  cleanup.push(() => app.close(), () => fake.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'sam', password: randomBytes(12).toString('base64url') },
  });
  const cookie = `offbeat_session=${res.cookies.find((c) => c.name === 'offbeat_session')?.value}`;
  const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
  return { app, db, fake, call };
}

describe('Last.fm connection', () => {
  it('checks the key with Last.fm, stores it encrypted, and only ever shows its last four characters', async () => {
    const { db, call } = await setup();
    expect((await call('GET', '/settings/lastfm')).json()).toEqual({ configured: false, keyEnding: null });

    const saved = await call('PUT', '/settings/lastfm', { apiKey: LASTFM_KEY });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<LastfmSettingsView>()).toEqual({ configured: true, keyEnding: 'cdef' });
    expect(saved.body).not.toContain(LASTFM_KEY);
    const row = db.select().from(settings).all().find((r) => r.key === 'lastfm')!;
    expect(row.encrypted).toBe(true);
    expect(row.value).not.toContain(LASTFM_KEY);
  });

  it('refuses a key Last.fm rejects, with a readable 422, and saves nothing', async () => {
    const { call } = await setup();
    const res = await call('PUT', '/settings/lastfm', { apiKey: 'ffffffffffffffffffffffffffffffff' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ message: string }>().message).toMatch(/rejected that API key/);
    expect((await call('GET', '/settings/lastfm')).json<LastfmSettingsView>().configured).toBe(false);
  });

  it('rejects something that is not shaped like a key before asking Last.fm', async () => {
    const { fake, call } = await setup();
    expect((await call('PUT', '/settings/lastfm', { apiKey: 'not a key' })).statusCode).toBe(400);
    expect(fake.requests).toEqual([]);
  });

  it('can be disconnected', async () => {
    const { call } = await setup();
    await call('PUT', '/settings/lastfm', { apiKey: LASTFM_KEY });
    expect((await call('DELETE', '/settings/lastfm', {})).json<LastfmSettingsView>().configured).toBe(false);
    expect((await call('GET', '/account')).json<AccountView>().lastfmAvailable).toBe(false);
  });
});

describe('listening accounts', () => {
  it('starts empty and says whether Last.fm is available', async () => {
    const { call } = await setup();
    expect((await call('GET', '/account')).json()).toEqual({
      username: 'sam',
      role: 'admin',
      lastfmUsername: null,
      listenbrainzUsername: null,
      lastfmAvailable: false,
      listenbrainzSubmit: null,
    });
  });

  it('checks a ListenBrainz token before submitting plays with it, and never shows it again', async () => {
    const { call, fake } = await setup();
    const token = '11111111-2222-4333-8444-555555555555';
    expect((await call('PUT', '/account/listenbrainz-token', { token: 'not a token' })).statusCode).toBe(400);
    const wrong = await call('PUT', '/account/listenbrainz-token', { token: '99999999-2222-4333-8444-555555555555' });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json<{ message: string }>().message).toContain('did not accept that token');

    const saved = await call('PUT', '/account/listenbrainz-token', { token });
    expect(saved.json<AccountView>().listenbrainzSubmit).toEqual({ userName: 'sam_lb', lastSubmittedAt: null, pending: 0, error: null });
    expect(saved.body).not.toContain(token);
    expect((await call('GET', '/account')).body).not.toContain(token);
    expect(fake.requests).toContain('/listenbrainz/1/validate-token');

    expect((await call('DELETE', '/account/listenbrainz-token', {})).json<AccountView>().listenbrainzSubmit).toBeNull();
  });

  it("checks names with each service and keeps Last.fm's own spelling", async () => {
    const { call } = await setup();
    await call('PUT', '/settings/lastfm', { apiKey: LASTFM_KEY });
    const res = await call('PUT', '/account/listening', { lastfmUsername: ' SAM ', listenbrainzUsername: 'sam_lb' });
    expect(res.statusCode).toBe(200);
    expect(res.json<AccountView>()).toMatchObject({ lastfmUsername: 'Sam', listenbrainzUsername: 'sam_lb' });
  });

  it('needs Last.fm connected before a Last.fm name can be saved', async () => {
    const { call } = await setup();
    const res = await call('PUT', '/account/listening', { lastfmUsername: 'sam' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ message: string }>().message).toMatch(/not connected/);
  });

  it('saves nothing when any name is unknown', async () => {
    const { call } = await setup();
    await call('PUT', '/settings/lastfm', { apiKey: LASTFM_KEY });
    const res = await call('PUT', '/account/listening', { lastfmUsername: 'sam', listenbrainzUsername: 'nobody_here' });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ message: string }>().message).toBe('ListenBrainz has no user called nobody_here');
    expect((await call('GET', '/account')).json<AccountView>()).toMatchObject({ lastfmUsername: null, listenbrainzUsername: null });
  });

  it('clears a name when it is sent empty, and leaves omitted ones alone', async () => {
    const { call } = await setup();
    await call('PUT', '/account/listening', { listenbrainzUsername: 'sam_lb' });
    await call('PUT', '/settings/lastfm', { apiKey: LASTFM_KEY });
    await call('PUT', '/account/listening', { lastfmUsername: 'sam' });
    const cleared = await call('PUT', '/account/listening', { listenbrainzUsername: '' });
    expect(cleared.json<AccountView>()).toMatchObject({ lastfmUsername: 'Sam', listenbrainzUsername: null });
  });

  it('only admins manage the Last.fm key; members still manage their own names', async () => {
    const { app, db, call } = await setup();
    await call('PUT', '/settings/lastfm', { apiKey: LASTFM_KEY });
    const member = db.insert(users).values({ username: 'pat', passwordHash: 'x', role: 'user' }).returning().get();
    const headers = { cookie: `offbeat_session=${createSession(db, member.id).token}` };

    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/lastfm', headers })).statusCode).toBe(403);
    const replace = await app.inject({ method: 'PUT', url: '/api/v1/settings/lastfm', headers, payload: { apiKey: LASTFM_KEY } });
    expect(replace.statusCode).toBe(403);
    const own = await app.inject({ method: 'PUT', url: '/api/v1/account/listening', headers, payload: { lastfmUsername: 'sam' } });
    expect(own.json<AccountView>()).toMatchObject({ username: 'pat', lastfmUsername: 'Sam' });
    expect((await call('GET', '/account')).json<AccountView>().lastfmUsername).toBeNull(); // the admin's own is untouched
  });
});
