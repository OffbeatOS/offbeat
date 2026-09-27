import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { normalizeLidarrUrl } from '../src/integrations/lidarr/client.js';
import { openDatabase } from '../src/db/index.js';
import { type FakeLidarr, startFakeLidarr } from './fake-lidarr.js';

const password = () => randomBytes(12).toString('base64url');
const fakes: FakeLidarr[] = [];

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function fake(options?: Parameters<typeof startFakeLidarr>[0]) {
  const lidarr = await startFakeLidarr(options);
  fakes.push(lidarr);
  return lidarr;
}

/** An app with an admin signed in; returns an inject helper that carries the cookie. */
async function signedInAdmin() {
  const db = openDatabase(':memory:');
  const app = await buildApp({
    config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
    db,
    secretKey: randomBytes(32),
    webRoot: null,
    logger: false,
    upstreamTimeoutMs: 300,
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'admin', password: password() },
  });
  const token = setup.cookies.find((c) => c.name === 'offbeat_session')?.value;
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie: `offbeat_session=${token}` },
      ...(payload ? { payload } : {}),
    });
  return { app, db, call };
}

const defaults = { qualityProfileId: 2, metadataProfileId: 1, rootFolderPath: '/music' };

describe('normalizeLidarrUrl', () => {
  it.each([
    ['http://lidarr:8686', 'http://lidarr:8686'],
    ['http://lidarr:8686/', 'http://lidarr:8686'],
    ['  http://lidarr:8686///  ', 'http://lidarr:8686'],
    ['http://host/lidarr/', 'http://host/lidarr'],
    ['http://host:8686/api/v1', 'http://host:8686'],
    ['https://music.example.com/lidarr/api', 'https://music.example.com/lidarr'],
  ])('%j becomes %j', (input, expected) => {
    expect(normalizeLidarrUrl(input)).toBe(expected);
  });

  it.each(['lidarr:8686', 'ftp://lidarr', 'not a url'])('rejects %j', (input) => {
    expect(() => normalizeLidarrUrl(input)).toThrow();
  });
});

describe('testing a Lidarr connection', () => {
  it('loads profiles and root folders, sorted by name', async () => {
    const lidarr = await fake();
    const { call } = await signedInAdmin();
    const res = await call('POST', '/setup/lidarr/test', { url: lidarr.url, apiKey: lidarr.apiKey });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: '3.1.0.4875',
      qualityProfiles: [
        { id: 1, name: 'Any' },
        { id: 2, name: 'Lossless' },
      ],
      metadataProfiles: [{ id: 1, name: 'Standard' }],
      rootFolders: [
        { path: '/music', freeSpace: 1_000_000, defaultQualityProfileId: 2, defaultMetadataProfileId: 1 },
      ],
    });
  });

  it('accepts a trailing slash', async () => {
    const lidarr = await fake();
    const { call } = await signedInAdmin();
    const res = await call('POST', '/setup/lidarr/test', { url: `${lidarr.url}/`, apiKey: lidarr.apiKey });
    expect(res.statusCode).toBe(200);
  });

  it('works with a Lidarr URL base, and explains when it is missing', async () => {
    const lidarr = await fake({ urlBase: '/lidarr' });
    const { call } = await signedInAdmin();
    const withBase = await call('POST', '/setup/lidarr/test', { url: `${lidarr.url}/`, apiKey: lidarr.apiKey });
    expect(withBase.statusCode).toBe(200);
    expect(lidarr.requests).toContain('/lidarr/api/v1/system/status');

    const withoutBase = await call('POST', '/setup/lidarr/test', {
      url: lidarr.url.replace('/lidarr', ''),
      apiKey: lidarr.apiKey,
    });
    expect(withoutBase.statusCode).toBe(422);
    expect(withoutBase.json().message).toMatch(/URL base/);
  });

  it('reports a wrong API key as 422, never 401, so the browser session is not dropped', async () => {
    const lidarr = await fake();
    const { call } = await signedInAdmin();
    const res = await call('POST', '/setup/lidarr/test', { url: lidarr.url, apiKey: 'wrong' });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/rejected the API key/);
  });

  it('explains a closed port quickly', async () => {
    const port = await freePort();
    const { call } = await signedInAdmin();
    const res = await call('POST', '/setup/lidarr/test', { url: `http://127.0.0.1:${port}`, apiKey: 'x' });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/Nothing is listening/);
  });

  it('gives up on a host that never answers, with a clear message', async () => {
    const lidarr = await fake({ mode: 'hang' });
    const { call } = await signedInAdmin();
    const started = Date.now();
    const res = await call('POST', '/setup/lidarr/test', { url: lidarr.url, apiKey: lidarr.apiKey });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/did not respond/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.each([
    ['html', /not like Lidarr/],
    ['sonarr', /Sonarr, not Lidarr/],
  ] as const)('recognizes a %s server that is not Lidarr', async (mode, message) => {
    const lidarr = await fake({ mode });
    const { call } = await signedInAdmin();
    const res = await call('POST', '/setup/lidarr/test', { url: lidarr.url, apiKey: lidarr.apiKey });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(message);
  });

  it('is admin only', async () => {
    const lidarr = await fake();
    const { app } = await signedInAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/lidarr/test',
      payload: { url: lidarr.url, apiKey: lidarr.apiKey },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('saving Lidarr settings', () => {
  it('stores the whole section encrypted and never returns the API key', async () => {
    const lidarr = await fake();
    const { call, db } = await signedInAdmin();

    const saved = await call('POST', '/setup/lidarr', { url: `${lidarr.url}/`, apiKey: lidarr.apiKey, ...defaults });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ url: lidarr.url, ...defaults });

    const row = db.$client.prepare("select value, encrypted from settings where key = 'lidarr'").get() as {
      value: string;
      encrypted: number;
    };
    expect(row.encrypted).toBe(1);
    expect(row.value).toMatch(/^v1:/);
    expect(row.value).not.toContain(lidarr.apiKey);
    expect(row.value).not.toContain('127.0.0.1');

    const read = await call('GET', '/settings/lidarr');
    expect(read.json()).toEqual({ settings: { url: lidarr.url, ...defaults } });
    for (const res of [saved, read, await call('GET', '/setup/state')]) {
      expect(res.body).not.toContain(lidarr.apiKey);
      expect(res.body).not.toMatch(/apiKey/i);
    }
    expect((await call('GET', '/setup/state')).json()).toEqual({ needsAdmin: false, lidarrConfigured: true });
  });

  it('keeps the saved key when editing the same address, but not for a new one', async () => {
    const lidarr = await fake();
    const { call } = await signedInAdmin();
    await call('POST', '/setup/lidarr', { url: lidarr.url, apiKey: lidarr.apiKey, ...defaults });

    const sameHost = await call('PUT', '/settings/lidarr', { url: lidarr.url, ...defaults, rootFolderPath: '/music' });
    expect(sameHost.statusCode).toBe(200);

    // Sending the saved key to a different host could leak it, so it must be re-entered.
    const other = await fake();
    const newHost = await call('POST', '/setup/lidarr/test', { url: other.url });
    expect(newHost.statusCode).toBe(400);
    expect(newHost.json().message).toMatch(/API key/);
    expect(other.requests).toEqual([]);
  });

  it('refuses defaults that Lidarr does not have', async () => {
    const lidarr = await fake();
    const { call } = await signedInAdmin();
    const res = await call('POST', '/setup/lidarr', { url: lidarr.url, apiKey: lidarr.apiKey, ...defaults, qualityProfileId: 99 });
    expect(res.statusCode).toBe(400);
    expect((await call('GET', '/setup/state')).json().lidarrConfigured).toBe(false);
  });
});

/** A port with nothing listening on it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}
