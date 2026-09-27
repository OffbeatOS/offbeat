import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(path.join(tmpdir(), 'offbeat-web-'));
  writeFileSync(
    path.join(webRoot, 'index.html'),
    '<!doctype html><html><head><base href="/"></head><body><ob-root></ob-root></body></html>',
  );
  writeFileSync(path.join(webRoot, 'main-ABCD1234.js'), 'console.log(1)');
  writeFileSync(path.join(webRoot, 'chunk-BtWPvyb-.js'), 'console.log(2)');
  writeFileSync(path.join(webRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

async function makeApp(baseUrl: string) {
  return buildApp({
    config: { baseUrl, trustProxy: false, logLevel: 'error' },
    db: openDatabase(':memory:'),
    secretKey: randomBytes(32),
    webRoot,
    logger: false,
  });
}

const html = { accept: 'text/html,application/xhtml+xml' };

describe.each(['', '/music'])('with BASE_URL %j', (baseUrl) => {
  it('serves the status endpoint', async () => {
    const app = await makeApp(baseUrl);
    const res = await app.inject(`${baseUrl}/api/v1/status`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', version: expect.any(String) });
  });

  it('returns JSON 404 for unknown API routes, never the SPA', async () => {
    const app = await makeApp(baseUrl);
    const res = await app.inject({ url: `${baseUrl}/api/v1/nope`, headers: html });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('serves index.html with the base href rewritten', async () => {
    const app = await makeApp(baseUrl);
    for (const url of [`${baseUrl}/`, `${baseUrl}/library`, `${baseUrl}/artist/abc`]) {
      const res = await app.inject({ url, headers: html });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain(`<base href="${baseUrl}/">`);
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves hashed assets with long cache headers', async () => {
    const app = await makeApp(baseUrl);
    for (const file of ['main-ABCD1234.js', 'chunk-BtWPvyb-.js']) {
      const res = await app.inject(`${baseUrl}/${file}`);
      expect(res.statusCode, file).toBe(200);
      expect(res.headers['cache-control'], file).toContain('immutable');
    }
  });

  it('does not mark unhashed files immutable', async () => {
    const app = await makeApp(baseUrl);
    const res = await app.inject(`${baseUrl}/favicon.svg`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control'] ?? '').not.toContain('immutable');
  });

  it('404s missing assets instead of returning HTML', async () => {
    const app = await makeApp(baseUrl);
    const res = await app.inject({ url: `${baseUrl}/missing.js`, headers: { accept: '*/*' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('status healthcheck', () => {
  it('fails when the database is unusable', async () => {
    const db = openDatabase(':memory:');
    const app = await buildApp({
      config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
      db,
      secretKey: randomBytes(32),
      webRoot: null,
      logger: false,
    });
    db.$client.close();
    const res = await app.inject('/api/v1/status');
    expect(res.statusCode).toBe(500);
  });

  it('fails when migrations have not been applied', async () => {
    const db = openDatabase(':memory:');
    db.$client.exec('delete from __drizzle_migrations');
    const app = await buildApp({
      config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
      db,
      secretKey: randomBytes(32),
      webRoot: null,
      logger: false,
    });
    const res = await app.inject('/api/v1/status');
    expect(res.statusCode).toBe(500);
  });
});

describe('with a subpath BASE_URL', () => {
  it('redirects the bare subpath to its trailing slash form', async () => {
    const app = await makeApp('/music');
    const res = await app.inject('/music');
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/music/');
  });

  it('does not serve the app outside the subpath', async () => {
    const app = await makeApp('/music');
    const res = await app.inject({ url: '/library', headers: html });
    expect(res.statusCode).toBe(404);
  });
});
