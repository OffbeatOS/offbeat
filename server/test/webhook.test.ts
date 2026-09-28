import type { LidarrWebhookView } from '@offbeat/shared';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { startFakeCatalog } from './fake-catalog.js';
import { tmpImageDir } from './helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

/** Offbeat on a real port, so the fake Lidarr can call its webhook like the real one would. */
async function setup() {
  const fake = await startFakeCatalog();
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
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanup.push(() => app.close(), () => fake.close());
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const res = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'boss', password: randomBytes(12).toString('base64url') } });
  const cookie = `offbeat_session=${res.cookies.find((c) => c.name === 'offbeat_session')!.value}`;
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload || method !== 'GET' ? { payload: payload ?? {} } : {}) });
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
  const receiver = `${base}/api/v1/webhooks/lidarr`;
  const send = (credentials: string | null, body: object) =>
    fetch(receiver, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(credentials ? { authorization: `Basic ${Buffer.from(credentials).toString('base64')}` } : {}) },
      body: JSON.stringify(body),
    });
  return { app, fake, call, receiver, send };
}

describe('Lidarr webhook receiver', () => {
  it('only accepts the Basic auth credentials, and treats any event as a reason to look at Lidarr now', async () => {
    const { call, send, app } = await setup();
    const view = (await call('GET', '/settings/lidarr/webhook')).json<LidarrWebhookView>();
    expect(view).toMatchObject({ username: 'offbeat', callbackUrl: null, installed: false, lastEvent: null });
    expect(view.password.length).toBeGreaterThanOrEqual(32);

    const poll = vi.spyOn(app.activity, 'expectMovement');
    expect((await send(null, { eventType: 'Grab' })).status).toBe(401);
    expect((await send(`offbeat:${view.password}x`, { eventType: 'Grab' })).status).toBe(401);
    expect((await send(`someone:${view.password}`, { eventType: 'Grab' })).status).toBe(401);
    expect(poll).not.toHaveBeenCalled();

    expect((await send(`offbeat:${view.password}`, { eventType: 'Grab', albums: [{ title: 'Made up' }] })).status).toBe(204);
    expect(poll).toHaveBeenCalledTimes(1);
    expect((await call('GET', '/settings/lidarr/webhook')).json()).toMatchObject({ lastEvent: 'album grabbed' });
    // The body is never trusted: a malformed one is still just "look now".
    expect((await send(`offbeat:${view.password}`, { nonsense: true })).status).toBe(204);
    expect(poll).toHaveBeenCalledTimes(2);
    // A Test event is recorded but does not poll.
    expect((await send(`offbeat:${view.password}`, { eventType: 'Test' })).status).toBe(204);
    expect(poll).toHaveBeenCalledTimes(2);
    expect((await call('GET', '/settings/lidarr/webhook')).json()).toMatchObject({ lastEvent: 'test' });
  });
});

describe('Set Up Automatically', () => {
  it('tests the address first: refuses one Lidarr cannot reach, and one that is not this Offbeat', async () => {
    const { call, fake } = await setup();
    const unreachable = await call('PUT', '/settings/lidarr/webhook', { callbackUrl: 'http://127.0.0.1:1/api/v1/webhooks/lidarr' });
    expect(unreachable.statusCode).toBe(422);
    expect(unreachable.json().message).toContain('Lidarr could not reach Offbeat');

    // Something else that answers 200 at that address.
    const other = createServer((_req, res) => res.writeHead(200).end('ok'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => other.close(resolve)));
    const elsewhere = await call('PUT', '/settings/lidarr/webhook', {
      callbackUrl: `http://127.0.0.1:${(other.address() as AddressInfo).port}/api/v1/webhooks/lidarr`,
    });
    expect(elsewhere.statusCode).toBe(422);
    expect(elsewhere.json().message).toContain('was not this Offbeat');

    expect((await call('PUT', '/settings/lidarr/webhook', { callbackUrl: 'not a url' })).statusCode).toBe(400);
    expect(fake.notifications).toEqual([]);
  });

  it('creates one webhook with Basic auth (no token in the URL), and updates it rather than adding another', async () => {
    const { call, fake, receiver } = await setup();
    const saved = await call('PUT', '/settings/lidarr/webhook', { callbackUrl: receiver });
    expect(saved.statusCode).toBe(200);
    const view = saved.json<LidarrWebhookView>();
    expect(view).toMatchObject({ callbackUrl: receiver, installed: true, lastEvent: 'test' });
    expect(fake.notifications).toHaveLength(1);
    const field = (name: string) => fake.notifications[0]!.fields.find((f) => f.name === name)?.value;
    expect(field('url')).toBe(receiver);
    expect(String(field('url'))).not.toContain(view.password);
    expect(field('username')).toBe('offbeat');
    expect(field('password')).toBe(view.password);

    // An edited address (same Offbeat): tested, then the same webhook is updated.
    const edited = receiver.replace('127.0.0.1', 'localhost');
    expect((await call('PUT', '/settings/lidarr/webhook', { callbackUrl: edited })).statusCode).toBe(200);
    expect(fake.notifications).toHaveLength(1);
    expect(fake.notifications[0]!.fields.find((f) => f.name === 'url')?.value).toBe(edited);

    // Send Test works against the saved address.
    expect((await call('POST', '/settings/lidarr/webhook/test')).statusCode).toBe(200);
  });

  it('adopts a webhook someone added by hand for this receiver instead of duplicating it', async () => {
    const { call, fake, receiver } = await setup();
    fake.notifications.push({ id: 7, name: 'My Offbeat hook', implementation: 'Webhook', fields: [{ name: 'url', value: `${receiver}/` }] });
    expect((await call('PUT', '/settings/lidarr/webhook', { callbackUrl: receiver })).statusCode).toBe(200);
    expect(fake.notifications.map((n) => n.id)).toEqual([7]);
  });

  it('a new token is pushed to Lidarr; the old one stops working; Remove takes the webhook out', async () => {
    const { call, fake, receiver, send } = await setup();
    const first = (await call('PUT', '/settings/lidarr/webhook', { callbackUrl: receiver })).json<LidarrWebhookView>();
    const second = (await call('POST', '/settings/lidarr/webhook/token')).json<LidarrWebhookView>();
    expect(second.password).not.toBe(first.password);
    expect(fake.notifications[0]!.fields.find((f) => f.name === 'password')?.value).toBe(second.password);
    expect((await send(`offbeat:${first.password}`, { eventType: 'Grab' })).status).toBe(401);
    expect((await send(`offbeat:${second.password}`, { eventType: 'Grab' })).status).toBe(204);

    const removed = await call('DELETE', '/settings/lidarr/webhook');
    expect(removed.json()).toMatchObject({ installed: false, callbackUrl: null });
    expect(fake.notifications).toEqual([]);
  });
});
