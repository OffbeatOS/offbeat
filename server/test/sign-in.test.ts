import type { CreatedUser, MeResponse, SignInSettings } from '@offbeat/shared';
import { eq } from 'drizzle-orm';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { blockListOf, clientAddress, dockerGateway, dockerStandIns } from '../src/auth/network.js';
import { openDatabase } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { tmpImageDir } from './helpers.js';

const password = () => randomBytes(12).toString('base64url');
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

const PROXY = '10.0.0.2';
const LAN_CLIENT = '192.168.1.50';
const INTERNET = '203.0.113.9';

async function setup() {
  const app = await buildApp({
    config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
    db: openDatabase(':memory:'),
    secretKey: randomBytes(32),
    imageCacheDir: tmpImageDir(),
    webRoot: null,
    logger: false,
    activity: { autoStart: false },
    discovery: { schedule: null },
  });
  cleanup.push(() => app.close());
  const adminPassword = password();
  const res = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'boss', password: adminPassword } });
  const admin = `offbeat_session=${res.cookies.find((c) => c.name === 'offbeat_session')!.value}`;
  const as = (opts: { from?: string; headers?: Record<string, string>; cookie?: string }) => (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress: opts.from ?? '127.0.0.1',
      headers: { ...(opts.headers ?? {}), ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      ...(payload || method !== 'GET' ? { payload: payload ?? {} } : {}),
    });
  const adminCall = as({ cookie: admin });
  const configure = async (change: (s: SignInSettings) => void) => {
    const current = (await adminCall('GET', '/settings/sign-in')).json<SignInSettings>();
    change(current);
    const { localAccounts, proxy, autoLogin } = current;
    return adminCall('PUT', '/settings/sign-in', { localAccounts, proxy, autoLogin });
  };
  const addMember = async (username: string) =>
    (await adminCall('POST', '/users', { username, role: 'user', permissions: ['add-albums'] })).json<CreatedUser>();
  return { app, admin, as, adminCall, configure, addMember, adminPassword };
}

const me = async (res: Promise<{ json: <T>() => T }>) => (await res).json<MeResponse>();

describe('client address', () => {
  const trusted = blockListOf([PROXY, '172.30.0.0/24']);

  it('ignores forwarding headers unless the connection is from a trusted proxy', () => {
    expect(clientAddress(INTERNET, { 'x-forwarded-for': LAN_CLIENT }, trusted)).toMatchObject({ client: INTERNET, viaTrustedProxy: false, untrustedForwarding: true });
    expect(clientAddress(LAN_CLIENT, {}, trusted)).toMatchObject({ client: LAN_CLIENT, untrustedForwarding: false });
  });

  it('through trusted proxies, takes the nearest address that is not one of them', () => {
    expect(clientAddress(PROXY, { 'x-forwarded-for': `${LAN_CLIENT}, 172.30.0.5` }, trusted).client).toBe(LAN_CLIENT);
    // A client cannot claim to be local by writing its own X-Forwarded-For: the proxy appends the real one.
    expect(clientAddress(PROXY, { 'x-forwarded-for': `${LAN_CLIENT}, ${INTERNET}` }, trusted).client).toBe(INTERNET);
    expect(clientAddress(PROXY, {}, trusted).client).toBeNull();
    expect(clientAddress(`::ffff:${PROXY}`, { 'x-forwarded-for': LAN_CLIENT }, trusted).client).toBe(LAN_CLIENT);
  });

  it('finds the Docker gateway from the routing table, only inside Docker', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'offbeat-route-'));
    const route = path.join(dir, 'route');
    writeFileSync(route, 'Iface\tDestination\tGateway\tFlags\neth0\t00000000\t010011AC\t0003\neth0\t000011AC\t00000000\t0001\n');
    writeFileSync(path.join(dir, '.dockerenv'), '');
    expect(dockerGateway(route, path.join(dir, '.dockerenv'))).toBe('172.17.0.1');
    expect(dockerGateway(route, path.join(dir, 'missing'))).toBeNull();
  });

  it('on Docker Desktop, also counts its gateway (the source of published-port traffic) as standing for anyone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'offbeat-route-'));
    const route = path.join(dir, 'route');
    writeFileSync(route, 'Iface\tDestination\tGateway\tFlags\neth0\t00000000\t01631FAC\t0003\n');
    writeFileSync(path.join(dir, '.dockerenv'), '');
    const desktop = { 'gateway.docker.internal': '192.168.65.1', 'host.docker.internal': '192.168.65.254' } as Record<string, string>;
    const found = await dockerStandIns(async (host) => desktop[host] ?? null, route, path.join(dir, '.dockerenv'));
    expect(found).toEqual(['172.31.99.1', '192.168.65.1', '192.168.65.254']);
    // Plain Linux Docker: no such names, just the bridge gateway.
    expect(await dockerStandIns(async () => null, route, path.join(dir, '.dockerenv'))).toEqual(['172.31.99.1']);
    expect(await dockerStandIns(async (host) => desktop[host] ?? null, route, path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('reverse proxy header', () => {
  it('is ignored until enabled with a trusted proxy, and needs one to be enabled', async () => {
    const { as, configure } = await setup();
    expect((await as({ from: PROXY, headers: { 'remote-user': 'boss' } })('GET', '/users')).statusCode).toBe(401);
    const refused = await configure((s) => (s.proxy.enabled = true));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain('Add the address of your reverse proxy');
  });

  it('signs in the named user only when the header comes from a trusted proxy', async () => {
    const { as, configure } = await setup();
    await configure((s) => Object.assign(s.proxy, { enabled: true, trustedProxies: [PROXY], logoutUrl: 'https://auth.example.com/logout' }));

    const viaProxy = as({ from: PROXY, headers: { 'remote-user': 'BOSS', 'x-forwarded-for': INTERNET } });
    expect(await me(viaProxy('GET', '/auth/me'))).toMatchObject({ user: { username: 'boss', role: 'admin' }, via: 'proxy', signOutUrl: 'https://auth.example.com/logout' });
    expect((await viaProxy('GET', '/users')).statusCode).toBe(200);

    // The same header sent straight to Offbeat, from anywhere else, is ignored.
    for (const from of [INTERNET, LAN_CLIENT, '127.0.0.1']) {
      const spoofed = as({ from, headers: { 'remote-user': 'boss', 'x-forwarded-for': PROXY } });
      expect((await spoofed('GET', '/users')).statusCode).toBe(401);
      expect((await me(spoofed('GET', '/auth/me'))).user).toBeNull();
    }
  });

  it('the proxy decides over any session cookie, and a request it did not label falls back to the cookie', async () => {
    const { as, configure, addMember, app } = await setup();
    await configure((s) => Object.assign(s.proxy, { enabled: true, trustedProxies: [PROXY] }));
    const created = await addMember('sam');
    app.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, created.user.id)).run();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'sam', password: created.temporaryPassword } });
    const samCookie = `offbeat_session=${login.cookies.find((c) => c.name === 'offbeat_session')!.value}`;

    expect((await me(as({ from: PROXY, headers: { 'remote-user': 'boss' }, cookie: samCookie })('GET', '/auth/me'))).user?.username).toBe('boss');
    expect((await me(as({ from: PROXY, cookie: samCookie })('GET', '/auth/me'))).user?.username).toBe('sam');
  });

  it('unknown users are refused with a clear answer, or created as Members when allowed, never as admins', async () => {
    const { as, configure, app } = await setup();
    await configure((s) => Object.assign(s.proxy, { enabled: true, trustedProxies: [PROXY] }));
    const eve = as({ from: PROXY, headers: { 'remote-user': 'eve' } });
    const refused = await eve('GET', '/discover/preferences');
    expect(refused.statusCode).toBe(401);
    expect(refused.json().message).toBe('There is no Offbeat account for this user. Ask an admin.');
    expect(await me(eve('GET', '/auth/me'))).toMatchObject({ user: null, unknownProxyUser: 'eve' });
    expect(app.db.select().from(users).all().map((u) => u.username)).toEqual(['boss']);

    await configure((s) => (s.proxy.autoCreate = true));
    expect(await me(eve('GET', '/auth/me'))).toMatchObject({ user: { username: 'eve', role: 'user', permissions: ['add-albums'] }, via: 'proxy' });
    expect((await eve('GET', '/users')).statusCode).toBe(403);
    // A name Offbeat could not use as a username is not created.
    expect((await me(as({ from: PROXY, headers: { 'remote-user': 'no spaces allowed' } })('GET', '/auth/me'))).user).toBeNull();
  });

  it('with a shared secret, the username only counts when the proxy also sends the secret', async () => {
    const { as, configure, adminCall } = await setup();
    const secret = randomBytes(24).toString('base64url');
    expect((await configure((st) => Object.assign(st.proxy, { enabled: true, trustedProxies: [PROXY], secret: 'short' }))).statusCode).toBe(400);
    const saved = await configure((st) => Object.assign(st.proxy, { enabled: true, trustedProxies: [PROXY], secret }));
    expect(saved.statusCode).toBe(200);
    // The secret never comes back to the browser, only that one is set.
    expect(saved.json().proxy.secret).toBeNull();
    expect(saved.json().proxySecretSet).toBe(true);
    expect(JSON.stringify((await adminCall('GET', '/settings/sign-in')).json())).not.toContain(secret);

    const from = (headers: Record<string, string>) => as({ from: PROXY, headers: { 'remote-user': 'boss', ...headers } })('GET', '/auth/me');
    // A proxy route that passes on a made-up Remote-User, without the secret: nobody.
    expect((await me(from({}))).user).toBeNull();
    expect((await me(from({ 'x-offbeat-proxy-secret': 'not-the-secret-at-all-no' }))).user).toBeNull();
    expect((await me(from({ 'x-offbeat-proxy-secret': secret }))).user?.username).toBe('boss');

    // Saving other changes (secret null) keeps it; "" clears it.
    await configure((st) => (st.proxy.autoCreate = true));
    expect((await me(from({}))).user).toBeNull();
    await configure((st) => (st.proxy.secret = ''));
    expect((await adminCall('GET', '/settings/sign-in')).json().proxySecretSet).toBe(false);
    expect((await me(from({}))).user?.username).toBe('boss');
  });

  it('local accounts off: Members must come through the proxy; admins can still use a password', async () => {
    const { configure, addMember, app, adminPassword } = await setup();
    const sam = await addMember('sam');
    await configure((s) => (s.localAccounts = false));
    const login = (username: string, pw: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: pw } });
    const refused = await login('sam', sam.temporaryPassword);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toContain('usual sign-in page');
    expect((await login('boss', adminPassword)).statusCode).toBe(200);
  });
});

describe('local network auto-login', () => {
  async function withAutoLogin(extra: (s: SignInSettings) => void = () => undefined) {
    const ctx = await setup();
    const sam = await ctx.addMember('sam');
    const saved = await ctx.configure((s) => {
      Object.assign(s.autoLogin, { enabled: true, userId: sam.user.id, networks: ['192.168.1.0/24'] });
      extra(s);
    });
    expect(saved.statusCode).toBe(200);
    return { ...ctx, sam };
  }

  it('signs in the chosen Member from the local network, and nobody from anywhere else', async () => {
    const { as } = await withAutoLogin();
    expect(await me(as({ from: LAN_CLIENT })('GET', '/auth/me'))).toMatchObject({ user: { username: 'sam' }, via: 'auto-login' });
    expect((await as({ from: LAN_CLIENT })('GET', '/discover/preferences')).statusCode).toBe(200);
    expect((await as({ from: INTERNET })('GET', '/discover/preferences')).statusCode).toBe(401);
  });

  it('a spoofed X-Forwarded-For sent straight to Offbeat never counts as local', async () => {
    const { as } = await withAutoLogin();
    expect((await as({ from: INTERNET, headers: { 'x-forwarded-for': LAN_CLIENT } })('GET', '/auth/me')).json().user).toBeNull();
    // A proxy nobody declared, on the local network, forwarding an internet client: cannot be verified, so not local.
    expect((await as({ from: LAN_CLIENT, headers: { 'x-forwarded-for': INTERNET } })('GET', '/auth/me')).json().user).toBeNull();
  });

  it('through a trusted proxy, uses the real client: outside the network is not local', async () => {
    const { as } = await withAutoLogin((s) => (s.proxy.trustedProxies = [PROXY]));
    expect((await as({ from: PROXY, headers: { 'x-forwarded-for': INTERNET } })('GET', '/auth/me')).json().user).toBeNull();
    // Even with the client trying to put a local address first.
    expect((await as({ from: PROXY, headers: { 'x-forwarded-for': `${LAN_CLIENT}, ${INTERNET}` } })('GET', '/auth/me')).json().user).toBeNull();
    expect((await as({ from: PROXY, headers: { 'x-forwarded-for': '192.168.1.60' } })('GET', '/auth/me')).json().user?.username).toBe('sam');
    // The proxy itself, with no client address, is not local either.
    expect((await as({ from: PROXY })('GET', '/auth/me')).json().user).toBeNull();
  });

  it('never signs in as an admin, and refuses networks that are not a local network', async () => {
    const { configure, adminCall, as, sam, app } = await withAutoLogin();
    const bossId = app.db.select().from(users).where(eq(users.username, 'boss')).get()!.id;
    const asAdmin = await configure((s) => (s.autoLogin.userId = bossId));
    expect(asAdmin.statusCode).toBe(400);
    expect(asAdmin.json().message).toContain('never sign in as an admin');
    expect((await configure((s) => (s.autoLogin.networks = ['0.0.0.0/0']))).statusCode).toBe(400);
    expect((await configure((s) => (s.autoLogin.networks = ['192.168.1.0/33']))).statusCode).toBe(400);

    // Promoted after auto-login was set up: auto-login stops rather than sign in an admin.
    await adminCall('PATCH', `/users/${sam.user.id}`, { role: 'admin' });
    expect((await as({ from: LAN_CLIENT })('GET', '/auth/me')).json().user).toBeNull();
  });

  it('shows the admin which address Offbeat sees for them', async () => {
    const { adminCall } = await withAutoLogin();
    expect((await adminCall('GET', '/settings/sign-in')).json()).toMatchObject({ yourAddress: '127.0.0.1', dockerAddresses: [] });
  });
});
