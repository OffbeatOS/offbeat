import type { LidarrWebhookView } from '@offbeat/shared';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LidarrError, type LidarrNotification, type LidarrNotificationInput } from '../integrations/lidarr/client.js';
import { clientFor, loadLidarr } from '../integrations/lidarr/settings.js';
import { HttpError, parse } from './errors.js';

const KEY = 'lidarr-webhook';
const USERNAME = 'offbeat';
const PATH = '/api/v1/webhooks/lidarr';
/** Lidarr calls back during a test; allow for a slow Lidarr or network. */
const TEST_TIMEOUT_MS = 30_000;
/** A Grab arrives just before the release is in Lidarr's queue; check again after this. */
const GRAB_RECHECK_MS = 1500;

const storedSchema = z.object({
  token: z.string(),
  callbackUrl: z.string().nullable().default(null),
  lidarrId: z.number().nullable().default(null),
  lastEventAt: z.string().nullable().default(null),
  lastEvent: z.string().nullable().default(null),
});
type Stored = z.infer<typeof storedSchema>;

const setupBody = z.object({
  callbackUrl: z
    .string()
    .trim()
    .url('use a full address, like http://192.168.1.20:3001/api/v1/webhooks/lidarr')
    .refine((u) => /^https?:\/\//i.test(u), 'use an http or https address'),
});

/** What each Lidarr event means, for "Last event 2 minutes ago: album imported". */
const EVENT_LABEL: Record<string, string> = {
  Test: 'test',
  Grab: 'album grabbed',
  Download: 'album imported',
  DownloadFailure: 'download failed',
  ImportFailure: 'import failed',
  AlbumDelete: 'album deleted',
  ArtistDelete: 'artist deleted',
  ArtistAdd: 'artist added',
};

/**
 * Lidarr webhook: Lidarr tells Offbeat the moment something is grabbed or
 * imported, and Activity polls at once. Polling on a timer stays as the
 * fallback. The webhook authenticates with Basic auth (user `offbeat`, the
 * token as password), never a token in the URL. Its body is not trusted:
 * an event only means "look at Lidarr now".
 */
export const webhookRoutes: FastifyPluginAsync<{ baseUrl: string }> = async (app, { baseUrl }) => {
  const admin = { config: { role: 'admin' as const } };
  /** When the last Test event arrived here, to confirm a Lidarr test really reached this Offbeat. */
  let testReceivedAt = 0;

  const load = (): Stored | null => app.settings.get(KEY, storedSchema);
  const save = (value: Stored) => app.settings.set(KEY, value, { encrypted: true });
  const ensure = (): Stored => {
    const current = load();
    if (current) return current;
    const created: Stored = { token: newToken(), callbackUrl: null, lidarrId: null, lastEventAt: null, lastEvent: null };
    save(created);
    return created;
  };

  // The receiver. Public (no session, proxy header, or auto-login); only the token counts.
  app.post(PATH.replace('/api/v1', ''), { config: { public: true } }, async (request, reply) => {
    const stored = load();
    if (!stored || !basicAuthMatches(request, stored.token)) {
      return reply.code(401).header('www-authenticate', 'Basic realm="Offbeat"').send({ error: 'Unauthorized', message: 'Wrong webhook credentials' });
    }
    const type = typeof (request.body as { eventType?: unknown } | null)?.eventType === 'string' ? (request.body as { eventType: string }).eventType : 'Unknown';
    if (type === 'Test') testReceivedAt = Date.now();
    else void app.activity.expectMovement(); // look at Lidarr now, and closely for a while
    // Lidarr sends Grab just before the release reaches its queue, so the check above can
    // miss it: look once more a moment later.
    if (type === 'Grab') setTimeout(() => void app.activity.wake(), GRAB_RECHECK_MS).unref();
    save({ ...stored, lastEventAt: new Date().toISOString(), lastEvent: EVENT_LABEL[type] ?? type.toLowerCase() });
    request.log.info({ eventType: type }, 'Lidarr webhook');
    return reply.code(204).send();
  });

  app.get('/settings/lidarr/webhook', admin, async (request): Promise<LidarrWebhookView> => {
    const stored = ensure();
    const installed = await findOurs(stored)
      .then((n) => !!n)
      .catch(() => false);
    return view(stored, installed, request);
  });

  /** Set Up Automatically (or save an edited address): test first, then create or update Offbeat's webhook. */
  app.put('/settings/lidarr/webhook', admin, async (request): Promise<LidarrWebhookView> => {
    const { callbackUrl } = parse(setupBody, request.body);
    const stored = ensure();
    const client = lidarr(TEST_TIMEOUT_MS);
    const body = notificationFor(callbackUrl, stored.token);
    // Found first: Lidarr requires unique names even when testing, so a test of our
    // own webhook must say which one it is.
    const existing = await withLidarr(() => findOurs(stored));
    await testAt(client, body, callbackUrl, existing?.id);

    const saved = await withLidarr(() =>
      existing ? client.updateNotification(existing.id, body) : client.createNotification(body),
    );
    // Reread: the test event arrived while Lidarr was testing, and updated the record.
    const next = { ...load()!, callbackUrl, lidarrId: saved.id };
    save(next);
    return view(next, true, request);
  });

  /** Send Test: Lidarr sends its Test event to the saved address. */
  app.post('/settings/lidarr/webhook/test', admin, async (request): Promise<LidarrWebhookView> => {
    const stored = ensure();
    if (!stored.callbackUrl) throw new HttpError(409, 'Set up the webhook first');
    const existing = await withLidarr(() => findOurs(stored));
    await testAt(lidarr(TEST_TIMEOUT_MS), notificationFor(stored.callbackUrl, stored.token), stored.callbackUrl, existing?.id);
    return view(load()!, !!existing, request);
  });

  /** A new token; Lidarr's webhook is updated to match, so events keep arriving. */
  app.post('/settings/lidarr/webhook/token', admin, async (request): Promise<LidarrWebhookView> => {
    const stored = ensure();
    const next = { ...load()!, token: newToken() };
    const existing = await findOurs(stored).catch(() => null);
    if (existing && next.callbackUrl) {
      await withLidarr(() => lidarr().updateNotification(existing.id, notificationFor(next.callbackUrl!, next.token)));
    }
    save(next);
    return view(next, !!existing, request);
  });

  /** Removes Offbeat's webhook from Lidarr (polling carries on). */
  app.delete('/settings/lidarr/webhook', admin, async (request): Promise<LidarrWebhookView> => {
    const stored = ensure();
    const existing = await findOurs(stored).catch(() => null);
    if (existing) await withLidarr(() => lidarr().deleteNotification(existing.id));
    const next = { ...load()!, callbackUrl: null, lidarrId: null };
    save(next);
    return view(next, false, request);
  });

  function lidarr(timeoutMs?: number) {
    const settings = loadLidarr(app.settings);
    if (!settings) throw new HttpError(409, 'Connect Lidarr first');
    return clientFor(settings, timeoutMs);
  }

  /** Offbeat's webhook in Lidarr: the one we made, or any webhook pointing at this receiver path. */
  async function findOurs(stored: Stored): Promise<LidarrNotification | null> {
    const all = (await lidarr().notifications()).filter((n) => n.implementation === 'Webhook');
    return (
      all.find((n) => n.id === stored.lidarrId) ??
      all.find((n) => {
        const url = n.fields.find((f) => f.name === 'url')?.value;
        return n.name === 'Offbeat' || (typeof url === 'string' && url.replace(/\/+$/, '').endsWith(PATH));
      }) ??
      null
    );
  }

  /** Has Lidarr call the address with a Test event, and checks that it reached this Offbeat. */
  async function testAt(client: ReturnType<typeof lidarr>, body: LidarrNotificationInput, url: string, id?: number) {
    const started = Date.now();
    try {
      await client.testNotification(id === undefined ? body : { ...body, id });
    } catch (error) {
      const message = error instanceof LidarrError ? error.message : '';
      // Lidarr waiting on a connection that never answers: our request to Lidarr times out first.
      if (/did not respond/i.test(message)) {
        throw new HttpError(
          422,
          `Lidarr did not finish its test within ${TEST_TIMEOUT_MS / 1000} seconds, which usually means it cannot open a connection to ${url}: a firewall, a VPN container in front of Lidarr that blocks your local network, or the wrong address.`,
        );
      }
      throw new HttpError(
        422,
        `Lidarr could not reach Offbeat at ${url} (${message || 'the test failed'}). Use an address Lidarr can reach, such as this machine's network address; localhost usually will not work.`,
      );
    }
    // Lidarr says it worked; make sure it was this Offbeat that answered.
    for (let i = 0; i < 20 && testReceivedAt < started; i++) await new Promise((r) => setTimeout(r, 100));
    if (testReceivedAt < started) {
      throw new HttpError(422, `Something answered at ${url}, but it was not this Offbeat. Check the address and port.`);
    }
  }

  function view(stored: Stored, installed: boolean, request: FastifyRequest): LidarrWebhookView {
    return {
      callbackUrl: stored.callbackUrl,
      suggestedUrl: `${request.protocol}://${request.host}${baseUrl}${PATH}`,
      username: USERNAME,
      password: stored.token,
      installed,
      lastEventAt: stored.lastEventAt,
      lastEvent: stored.lastEvent,
    };
  }
};

function newToken() {
  return randomBytes(24).toString('base64url');
}

function basicAuthMatches(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization ?? '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const expected = Buffer.from(`${USERNAME}:${token}`);
  const given = Buffer.from(decoded);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function notificationFor(url: string, token: string): LidarrNotificationInput {
  return {
    name: 'Offbeat',
    implementation: 'Webhook',
    configContract: 'WebhookSettings',
    onGrab: true,
    onReleaseImport: true,
    onUpgrade: true,
    onDownloadFailure: true,
    onImportFailure: true,
    fields: [
      { name: 'url', value: url },
      { name: 'method', value: 1 },
      { name: 'username', value: USERNAME },
      { name: 'password', value: token },
      { name: 'headers', value: [] },
    ],
    tags: [],
  };
}

/** Lidarr errors as readable 422s (never 401, which would look like an expired session). */
async function withLidarr<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LidarrError) throw new HttpError(422, error.message);
    throw error;
  }
}
