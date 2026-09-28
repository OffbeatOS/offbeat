import type { NotificationSettingsView, WebhookPayload } from '@offbeat/shared';
import { createHmac, randomBytes } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import type { LidarrHistoryItem } from '../src/integrations/lidarr/client.js';
import { PermanentError, RetryableError, isDiscordWebhook, sendDiscord, unsafeUrl } from '../src/notifications/channels.js';
import { startFakeCatalog } from './fake-catalog.js';
import { tmpImageDir } from './helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
  json: Record<string, unknown>;
}

/** A stand-in for Discord or a webhook receiver: records requests, answers from a script. */
async function receiver(answers: ((res: ServerResponse) => void)[] = []) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body, json: body ? JSON.parse(body) : {} });
      const answer = answers.shift();
      if (answer) answer(res);
      else res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received };
}

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
    notifications: { retryDelaysMs: [20, 20, 20], releaseCheckMs: null },
  });
  cleanup.push(() => app.close(), () => fake.close());
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
  return { app, fake, call };
}

/** Channels saved straight into the notifier (the routes only accept real Discord addresses). */
function channels(app: Awaited<ReturnType<typeof setup>>['app'], urls: { discord?: string; webhook?: string; secret?: string }) {
  const all = ['album-imported', 'download-failed', 'import-blocked', 'new-release'] as const;
  app.notifier.save({
    publicUrl: 'https://offbeat.example.com',
    discord: urls.discord ? { enabled: true, url: urls.discord, events: [...all], lastTest: null } : null,
    webhook: urls.webhook ? { enabled: true, url: urls.webhook, secret: urls.secret ?? null, events: [...all], lastTest: null } : null,
  });
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

const record = (id: number, eventType: string, extra: Partial<LidarrHistoryItem> = {}): LidarrHistoryItem => ({
  id,
  eventType,
  date: new Date().toISOString(),
  albumId: 5,
  album: { id: 5, title: 'Untrue', foreignAlbumId: 'rg-untrue' },
  artist: { artistName: 'Burial', foreignArtistId: 'ar-burial' },
  downloadId: 'dl-1',
  ...extra,
});

describe('addresses', () => {
  it('refuses cloud metadata and other link-local addresses, directly or through a name', async () => {
    expect(await unsafeUrl('http://169.254.169.254/latest/meta-data')).toContain('link-local');
    expect(await unsafeUrl('http://[fe80::1]/hook')).toContain('link-local');
    expect(await unsafeUrl('http://metadata.google.internal/computeMetadata')).toContain('metadata');
    expect(await unsafeUrl('http://sneaky.example/hook', async () => [{ address: '169.254.169.254', family: 4 }])).toContain('link-local');
    expect(await unsafeUrl('ftp://example.com/hook')).toContain('http or https');
    expect(await unsafeUrl('https://user:pw@example.com/hook')).toContain('credentials');
    expect(await unsafeUrl('https://hooks.example.com/offbeat', async () => [{ address: '93.184.216.34', family: 4 }])).toBeNull();
    expect(await unsafeUrl('http://192.168.1.20:8080/hook')).toBeNull();
  });

  it('knows a Discord webhook URL when it sees one', () => {
    expect(isDiscordWebhook('https://discord.com/api/webhooks/123456789/abcDEF-ghi_jkl')).toBe(true);
    expect(isDiscordWebhook('https://discordapp.com/api/webhooks/123/abc')).toBe(true);
    expect(isDiscordWebhook('http://discord.com/api/webhooks/123/abc')).toBe(false);
    expect(isDiscordWebhook('https://discord.com.evil.example/api/webhooks/123/abc')).toBe(false);
    expect(isDiscordWebhook('https://example.com/api/webhooks/123/abc')).toBe(false);
  });
});

describe('Discord', () => {
  const message = {
    payload: {
      version: 1 as const,
      event: 'album-imported' as const,
      title: 'Album imported',
      message: 'Untrue by @everyone',
      url: 'https://offbeat.example.com/album/x',
      artist: null,
      album: null,
      reason: null,
      occurredAt: new Date().toISOString(),
    },
  };

  it('sends one embed with mentions turned off, so a name like @everyone pings nobody', async () => {
    const discord = await receiver();
    await sendDiscord(discord.url, message);
    const body = discord.received[0]!.json as { allowed_mentions: unknown; embeds: { title: string; description: string; url: string }[] };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0]).toMatchObject({ title: 'Album imported', description: 'Untrue by @everyone', url: 'https://offbeat.example.com/album/x' });
  });

  it('reads how long to wait from a 429, and gives up on a deleted webhook', async () => {
    const discord = await receiver([
      (res) => res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ retry_after: 1.5 })),
      (res) => res.writeHead(404).end(),
    ]);
    const limited = await sendDiscord(discord.url, message).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(RetryableError);
    expect((limited as RetryableError).retryAfterMs).toBe(1500);
    expect(await sendDiscord(discord.url, message).catch((e: unknown) => e)).toBeInstanceOf(PermanentError);
  });
});

describe('notifier', () => {
  it('sends one message per album download, however many history entries it has, and links back', async () => {
    const { app } = await setup();
    const hook = await receiver();
    channels(app, { webhook: hook.url });
    app.notifier.noticeHistory([record(10, 'grabbed')]); // first look: only remembers where things stand
    app.notifier.noticeHistory([
      record(14, 'downloadImported'),
      record(13, 'downloadImported'),
      record(12, 'trackFileImported'),
      record(11, 'trackFileImported'),
      record(15, 'downloadImported', { downloadId: 'dl-2', album: { id: 6, title: 'Kindred', foreignAlbumId: 'rg-kindred' }, albumId: 6 }),
      record(10, 'grabbed'),
    ]);
    await until(() => hook.received.length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(hook.received.map((r) => (r.json as unknown as WebhookPayload).message)).toEqual(['Untrue by Burial', 'Kindred by Burial']);
    expect(hook.received[0]!.json).toMatchObject({ version: 1, event: 'album-imported', title: 'Album imported', url: 'https://offbeat.example.com/album/rg-untrue' });
    // Seen once, never again.
    app.notifier.noticeHistory([record(15, 'downloadImported'), record(14, 'downloadImported')]);
    await new Promise((r) => setTimeout(r, 50));
    expect(hook.received).toHaveLength(2);
  });

  it('signs webhook bodies when a secret is set', async () => {
    const { app } = await setup();
    const hook = await receiver();
    const secret = 'a-shared-secret-of-some-length';
    channels(app, { webhook: hook.url, secret });
    app.notifier.noticeHistory([record(1, 'grabbed')]);
    app.notifier.noticeHistory([record(2, 'downloadFailed', { data: { message: 'Download client said no' } })]);
    await until(() => hook.received.length === 1);
    const got = hook.received[0]!;
    expect(got.headers['x-offbeat-signature']).toBe(`sha256=${createHmac('sha256', secret).update(got.body).digest('hex')}`);
    expect(got.json).toMatchObject({ event: 'download-failed', reason: 'Download client said no' });
  });

  it('retries until delivered, waits as long as Discord asks, and logs every step', async () => {
    const { app } = await setup();
    const discord = await receiver([
      (res) => res.writeHead(500).end(),
      (res) => res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ retry_after: 0.05 })),
    ]);
    channels(app, { discord: discord.url });
    app.notifier.noticeHistory([record(1, 'grabbed')]);
    app.notifier.noticeHistory([record(2, 'downloadImported')]);
    await until(() => app.notifier.recent()[0]?.status === 'delivered');
    expect(discord.received).toHaveLength(3);
    expect(app.notifier.recent()[0]).toMatchObject({ channel: 'discord', event: 'album-imported', status: 'delivered', attempts: 3 });
  });

  it('gives up after a few tries without blocking anything else, and records why', async () => {
    const { app } = await setup();
    const hook = await receiver([500, 500, 500, 500].map((code) => (res: ServerResponse) => res.writeHead(code).end()));
    channels(app, { webhook: hook.url });
    app.notifier.noticeHistory([record(1, 'grabbed')]);
    const started = Date.now();
    app.notifier.noticeHistory([record(2, 'downloadImported')]); // returns at once
    expect(Date.now() - started).toBeLessThan(50);
    await until(() => app.notifier.recent()[0]?.status === 'failed');
    expect(app.notifier.recent()[0]).toMatchObject({ status: 'failed', attempts: 4, error: 'The webhook answered HTTP 500' });
  });

  it('tells about a blocked import once, not about the ones already there', async () => {
    const { app } = await setup();
    const hook = await receiver();
    channels(app, { webhook: hook.url });
    const item = (id: string, state: 'import-blocked' | 'import-stuck') => ({
      id,
      state,
      albumMbid: 'rg-x',
      albumTitle: 'Rival Dealer',
      artistMbid: 'ar-burial',
      artistName: 'Burial',
      coverUrl: null,
      progress: null,
      detail: '',
      reason: 'The files did not match the album closely enough to import.',
      messages: [],
      source: 'Added in Lidarr',
      canRetry: true,
      canCancel: false,
      lidarrLink: null,
    });
    app.notifier.noticeAttention([item('queue:1', 'import-blocked')]);
    app.notifier.noticeAttention([item('queue:1', 'import-blocked'), item('queue:2', 'import-stuck')]);
    app.notifier.noticeAttention([item('queue:1', 'import-blocked'), item('queue:2', 'import-stuck')]);
    await until(() => hook.received.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(hook.received).toHaveLength(1);
    expect(hook.received[0]!.json).toMatchObject({ event: 'import-blocked', message: 'Rival Dealer by Burial' });
  });

  it('new releases: only albums that newly appear for monitored artists, never a freshly added artist', async () => {
    const { app, fake } = await setup();
    const hook = await receiver();
    channels(app, { webhook: hook.url });
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const artist = (name: string, monitored: boolean, added: string) => ({ artistName: name, foreignArtistId: `ar-${name}`, monitored, added });
    fake.calendar.push({ id: 1, title: 'Old news', foreignAlbumId: 'rg-1', releaseDate: old, artist: artist('Burial', true, old) });
    await app.notifier.checkNewReleases(); // first check: only records what is there
    fake.calendar.push(
      { id: 2, title: 'Antidawn', foreignAlbumId: 'rg-2', releaseDate: new Date(Date.now() + 5 * 86_400_000).toISOString(), artist: artist('Burial', true, old) },
      { id: 3, title: 'Unwatched', foreignAlbumId: 'rg-3', releaseDate: old, artist: artist('Somebody', false, old) },
      { id: 4, title: 'Back Catalog', foreignAlbumId: 'rg-4', releaseDate: old, artist: artist('Newcomer', true, new Date().toISOString()) },
    );
    await app.notifier.checkNewReleases();
    await until(() => hook.received.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(hook.received.map((r) => (r.json as unknown as WebhookPayload).message)).toEqual([expect.stringMatching(/^Antidawn by Burial, due /)]);
    await app.notifier.checkNewReleases();
    await new Promise((r) => setTimeout(r, 50));
    expect(hook.received).toHaveLength(1);
  });
});

describe('notification settings', () => {
  it('never sends the Discord token or the webhook secret back, and checks what it saves', async () => {
    const { call } = await setup();
    const token = randomBytes(24).toString('base64url');
    expect((await call('PUT', '/settings/notifications/discord', { enabled: true, url: 'https://example.com/not-discord', events: ['album-imported'] })).statusCode).toBe(400);
    const saved = await call('PUT', '/settings/notifications/discord', { enabled: true, url: `https://discord.com/api/webhooks/123456789/${token}`, events: ['album-imported'] });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(token);
    expect(saved.json<NotificationSettingsView>().discord).toMatchObject({ urlHint: 'discord.com/api/webhooks/123456789/••••', events: ['album-imported'] });
    // Saving without a URL keeps the saved one.
    expect((await call('PUT', '/settings/notifications/discord', { enabled: false, url: null, events: [] })).json<NotificationSettingsView>().discord?.urlHint).toContain('123456789');

    const metadata = await call('PUT', '/settings/notifications/webhook', { enabled: true, url: 'http://169.254.169.254/latest', secret: null, events: [] });
    expect(metadata.statusCode).toBe(400);
    const secret = 'shared-secret-for-signing-1';
    const hook = await call('PUT', '/settings/notifications/webhook', { enabled: true, url: 'http://192.168.1.20/hook', secret, events: ['new-release'] });
    expect(hook.body).not.toContain(secret);
    expect(hook.json<NotificationSettingsView>().webhook).toMatchObject({ secretSet: true, url: 'http://192.168.1.20/hook' });
    expect((await call('PUT', '/settings/notifications', { publicUrl: 'ftp://nope' })).statusCode).toBe(400);
    expect((await call('PUT', '/settings/notifications', { publicUrl: 'https://offbeat.example.com/' })).json()).toMatchObject({ publicUrl: 'https://offbeat.example.com' });
    expect((await call('DELETE', '/settings/notifications/discord')).json<NotificationSettingsView>().discord).toBeNull();
  });

  it('Send Test delivers one message now and says how it went', async () => {
    const { call, app } = await setup();
    const hook = await receiver([(res) => res.writeHead(204).end(), (res) => res.writeHead(410).end()]);
    channels(app, { webhook: hook.url });
    const ok = (await call('POST', '/settings/notifications/webhook/test')).json<NotificationSettingsView>();
    expect(ok.webhook?.lastTest).toMatchObject({ ok: true, error: null });
    expect(hook.received[0]!.json).toMatchObject({ event: 'test', title: 'Test from Offbeat', url: 'https://offbeat.example.com' });
    const failed = (await call('POST', '/settings/notifications/webhook/test')).json<NotificationSettingsView>();
    expect(failed.webhook?.lastTest).toMatchObject({ ok: false, error: 'The webhook answered HTTP 410' });
    expect(failed.deliveries.map((d) => [d.event, d.status])).toEqual([
      ['test', 'failed'],
      ['test', 'delivered'],
    ]);
  });
});
