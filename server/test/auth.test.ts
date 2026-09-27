import { tmpImageDir } from './helpers.js';
import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiErrorHandler } from '../src/api/errors.js';
import { buildApp } from '../src/app.js';
import { registerAuthGuard } from '../src/auth/guard.js';
import { LoginLimiter } from '../src/auth/login-limiter.js';
import { SESSION_TTL_MS, createSession, resolveSession } from '../src/auth/sessions.js';
import { openDatabase } from '../src/db/index.js';
import { users } from '../src/db/schema.js';

/** Fresh credentials per run; no real or shared passwords live in the tests. */
const password = () => randomBytes(12).toString('base64url');
const admin = { username: 'Admin', password: password() };

async function makeApp(baseUrl = '', loginLimiter?: LoginLimiter, trustProxy = false) {
  return buildApp({
    config: { baseUrl, trustProxy, logLevel: 'error' },
    db: openDatabase(':memory:'),
    secretKey: randomBytes(32),
    imageCacheDir: tmpImageDir(),
    webRoot: null,
    logger: false,
    loginLimiter,
  });
}

/** Turns a Set-Cookie response into a Cookie request header. */
function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  const cookie = res.cookies.find((c) => c.name === 'offbeat_session');
  if (!cookie) throw new Error('no session cookie');
  return `offbeat_session=${cookie.value}`;
}

describe('first-run setup', () => {
  it('reports that an admin is needed, then creates one and signs them in', async () => {
    const app = await makeApp();
    expect((await app.inject('/api/v1/setup/state')).json()).toEqual({ needsAdmin: true, lidarrConfigured: false });

    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: admin });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ username: 'Admin', role: 'admin' });

    const cookie = res.cookies.find((c) => c.name === 'offbeat_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });

    const me = await app.inject({ url: '/api/v1/auth/me', headers: { cookie: sessionCookie(res) } });
    expect(me.json()).toEqual({ user: { id: 1, username: 'Admin', role: 'admin' } });
    expect((await app.inject('/api/v1/setup/state')).json()).toEqual({ needsAdmin: false, lidarrConfigured: false });
  });

  it('refuses a second admin once setup is done', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: admin });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/admin',
      payload: { username: 'intruder', password: password() },
    });
    expect(res.statusCode).toBe(409);
    expect(app.db.select().from(users).all()).toHaveLength(1);
  });

  it('never stores the plain password', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: admin });
    const row = app.db.select().from(users).get();
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain(admin.password);
  });

  it.each([
    [{ username: 'ab', password: password() }, /username/],
    [{ username: 'has space', password: password() }, /username/],
    [{ username: 'fine', password: 'short' }, /password/],
  ])('validates %j', async (payload, message) => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(message);
  });

  it('scopes the cookie to BASE_URL', async () => {
    const app = await makeApp('/music');
    const res = await app.inject({ method: 'POST', url: '/music/api/v1/setup/admin', payload: admin });
    expect(res.cookies.find((c) => c.name === 'offbeat_session')?.path).toBe('/music/');
  });
});

describe('login and logout', () => {
  async function withAdmin(limiter?: LoginLimiter) {
    const app = await makeApp('', limiter);
    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: admin });
    return app;
  }

  it('signs in with the right password, ignoring username case', async () => {
    const app = await withAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: admin.password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: 'Admin' });
    const me = await app.inject({ url: '/api/v1/auth/me', headers: { cookie: sessionCookie(res) } });
    expect(me.json().user.username).toBe('Admin');
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const app = await withAdmin();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'Admin', password: password() },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ghost', password: password() },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('throttles repeated failures', async () => {
    const app = await withAdmin(new LoginLimiter(2, 60_000));
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'Admin', password: password() },
      });
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('logs out by deleting the session server side', async () => {
    const app = await withAdmin();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: admin });
    const cookie = sessionCookie(login);

    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie }, payload: {} });
    expect(out.statusCode).toBe(204);
    // Replaying the old cookie must not work.
    const me = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.json()).toEqual({ user: null });
  });

  it('rejects form posts, which a cross-site page could forge', async () => {
    const app = await withAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `username=Admin&password=${encodeURIComponent(admin.password)}`,
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('sessions', () => {
  it('expires, and slides forward when used late in its life', () => {
    const db = openDatabase(':memory:');
    db.insert(users).values({ username: 'a', passwordHash: 'x', role: 'admin' }).run();
    const start = new Date('2026-01-01T00:00:00Z');
    const { token } = createSession(db, 1, start);

    const early = resolveSession(db, token, new Date(start.getTime() + 1000));
    expect(early?.refreshed).toBe(false);

    const late = new Date(start.getTime() + SESSION_TTL_MS - 1000);
    const refreshed = resolveSession(db, token, late);
    expect(refreshed?.refreshed).toBe(true);
    expect(refreshed?.expiresAt.getTime()).toBe(late.getTime() + SESSION_TTL_MS);

    expect(resolveSession(db, token, new Date(late.getTime() + SESSION_TTL_MS + 1))).toBeNull();
    // Expired sessions are deleted on sight.
    expect(db.$client.prepare('select count(*) n from sessions').get()).toEqual({ n: 0 });
  });

  it('stores only a hash of the token', () => {
    const db = openDatabase(':memory:');
    db.insert(users).values({ username: 'a', passwordHash: 'x' }).run();
    const { token } = createSession(db, 1);
    const stored = db.$client.prepare('select id from sessions').get() as { id: string };
    expect(stored.id).not.toBe(token);
    expect(stored.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('route guard', () => {
  async function guarded() {
    const db = openDatabase(':memory:');
    db.insert(users).values([
      { username: 'boss', passwordHash: 'x', role: 'admin' },
      { username: 'pleb', passwordHash: 'x', role: 'user' },
    ]).run();
    const app = Fastify();
    app.decorate('db', db);
    await app.register(fastifyCookie);
    registerAuthGuard(app, { baseUrl: '' });
    app.setErrorHandler(apiErrorHandler);
    app.get('/open', { config: { public: true } }, async () => 'open');
    app.get('/private', async (request) => request.user?.username);
    app.get('/admin', { config: { role: 'admin' } }, async () => 'admin');
    const cookieFor = (userId: number) => `offbeat_session=${createSession(db, userId).token}`;
    return { app, cookieFor };
  }

  it('makes routes private unless they opt out', async () => {
    const { app, cookieFor } = await guarded();
    expect((await app.inject('/open')).statusCode).toBe(200);
    expect((await app.inject('/private')).statusCode).toBe(401);
    const res = await app.inject({ url: '/private', headers: { cookie: cookieFor(2) } });
    expect(res.body).toBe('pleb');
  });

  it('enforces the admin role', async () => {
    const { app, cookieFor } = await guarded();
    expect((await app.inject({ url: '/admin', headers: { cookie: cookieFor(2) } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/admin', headers: { cookie: cookieFor(1) } })).statusCode).toBe(200);
  });

  it('treats a forged or stale cookie as signed out and clears it', async () => {
    const { app } = await guarded();
    const res = await app.inject({ url: '/private', headers: { cookie: 'offbeat_session=forged' } });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === 'offbeat_session')?.value).toBe('');
  });
});

describe('hardening', () => {
  async function withAdmin(options: { limiter?: LoginLimiter; trustProxy?: boolean } = {}) {
    const app = await makeApp('', options.limiter, options.trustProxy);
    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: admin });
    return app;
  }

  it.each([
    ['text/plain', 'a cross-site form with enctype text/plain'],
    ['multipart/form-data; boundary=x', 'a cross-site multipart form'],
  ])('rejects %s bodies on writes (%s)', async (type) => {
    const app = await withAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': type },
      payload: JSON.stringify(admin),
    });
    expect(res.statusCode).toBe(415);
  });

  it('rejects body-less writes without a JSON content type', async () => {
    const app = await withAdmin();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: admin });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: sessionCookie(login) },
    });
    expect(res.statusCode).toBe(415);
  });

  it('refuses a second account that differs only by case, at the database level', async () => {
    const app = await withAdmin();
    expect(() =>
      app.db.insert(users).values({ username: 'ADMIN', passwordHash: 'x' }).run(),
    ).toThrow(/UNIQUE/);
  });

  it('only marks the cookie Secure for HTTPS reported by a trusted proxy', async () => {
    const httpsHeaders = { 'x-forwarded-proto': 'https' };
    const trusted = await makeApp('', undefined, true);
    const res = await trusted.inject({
      method: 'POST',
      url: '/api/v1/setup/admin',
      headers: httpsHeaders,
      payload: admin,
    });
    expect(res.cookies.find((c) => c.name === 'offbeat_session')).toMatchObject({ secure: true, sameSite: 'Lax' });

    const untrusted = await makeApp('', undefined, false);
    const spoofed = await untrusted.inject({
      method: 'POST',
      url: '/api/v1/setup/admin',
      headers: httpsHeaders,
      payload: admin,
    });
    expect(spoofed.cookies.find((c) => c.name === 'offbeat_session')?.secure).toBeFalsy();
  });

  it('throttles by the real client IP behind a trusted proxy', async () => {
    const app = await withAdmin({ limiter: new LoginLimiter(1, 60_000), trustProxy: true });
    const attempt = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': ip },
        payload: { username: 'Admin', password: password() },
      });
    expect((await attempt('203.0.113.1')).statusCode).toBe(401);
    expect((await attempt('203.0.113.1')).statusCode).toBe(429);
    // A different client behind the same proxy is not locked out.
    expect((await attempt('203.0.113.2')).statusCode).toBe(401);
  });

  it('ignores X-Forwarded-For when the proxy is not trusted, so it cannot dodge throttling', async () => {
    const app = await withAdmin({ limiter: new LoginLimiter(1, 60_000), trustProxy: false });
    const attempt = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': ip },
        payload: { username: 'Admin', password: password() },
      });
    expect((await attempt('203.0.113.1')).statusCode).toBe(401);
    expect((await attempt('203.0.113.99')).statusCode).toBe(429);
  });
});
