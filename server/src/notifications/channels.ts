import type { WebhookPayload } from '@offbeat/shared';
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { blockListOf, contains, normalizeAddress } from '../auth/network.js';
import { USER_AGENT } from '../version.js';

/** One message, ready for any channel. */
export interface Message {
  payload: WebhookPayload;
}

/** A send that should be tried again later, and when. */
export class RetryableError extends Error {
  constructor(
    message: string,
    /** How long the service asked us to wait (Discord's 429), if it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** A send that will never work as configured (for example a deleted Discord webhook). */
export class PermanentError extends Error {}

const SEND_TIMEOUT_MS = 10_000;

/**
 * Cloud metadata services live on link-local addresses (169.254.169.254 on
 * AWS, GCP, and Azure; fd00:ec2::254 on AWS IPv6). A notification URL must
 * never point there, even one an admin typed.
 */
const FORBIDDEN = blockListOf(['169.254.0.0/16', 'fe80::/10', 'fd00:ec2::254/128', '0.0.0.0/8']);
const FORBIDDEN_HOSTS = new Set(['metadata', 'metadata.google.internal', 'metadata.goog']);

/** Why a URL cannot be used for notifications, or null when it is fine. Resolves the host name too. */
export async function unsafeUrl(text: string, resolve = (host: string) => lookup(host, { all: true })): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'Use a full address, like https://example.com/hook';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use an http or https address';
  if (url.username || url.password) return 'Put credentials in the secret, not the address';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (FORBIDDEN_HOSTS.has(host)) return 'That address is a cloud metadata service, which Offbeat never sends to';
  const addresses = isIP(host) ? [host] : await resolve(host).then((all) => all.map((a) => a.address)).catch(() => null);
  if (!addresses) return `Could not find ${host}. Check the address.`;
  if (addresses.some((a) => contains(FORBIDDEN, normalizeAddress(a)))) {
    return 'That address is link-local (where cloud metadata services live), which Offbeat never sends to';
  }
  return null;
}

/** https://discord.com/api/webhooks/<id>/<token> (also the older discordapp.com and canary hosts). */
export function isDiscordWebhook(text: string): boolean {
  try {
    const url = new URL(text);
    return (
      url.protocol === 'https:' &&
      /^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/.test(url.hostname) &&
      /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** "…/webhooks/1234…/abcd…" becomes "…/webhooks/1234/••••": enough to recognize, never enough to use. */
export function maskDiscordUrl(text: string): string {
  const match = text.match(/\/webhooks\/(\d+)\//);
  return match ? `discord.com/api/webhooks/${match[1]}/••••` : '••••';
}

const COLORS: Record<string, number> = {
  'album-imported': 0x6cb4ff,
  'download-failed': 0xff8a7a,
  'import-blocked': 0xff8a7a,
  'new-release': 0xff6b4a,
  test: 0x9a9aa0,
};

/** Discord: one embed, and no mentions at all, so a name like "@everyone" cannot ping a server. */
export async function sendDiscord(url: string, { payload }: Message): Promise<void> {
  const body = {
    username: 'Offbeat',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: payload.title,
        description: [payload.message, payload.reason].filter(Boolean).join('\n'),
        ...(payload.url ? { url: payload.url } : {}),
        color: COLORS[payload.event],
        timestamp: payload.occurredAt,
      },
    ],
  };
  const res = await post(url, JSON.stringify(body), { 'content-type': 'application/json' });
  if (res.status === 429) {
    // Discord says how long to wait: retry_after in seconds, or the Retry-After header.
    const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
    const seconds = data.retry_after ?? Number(res.headers.get('retry-after') ?? NaN);
    throw new RetryableError('Discord is rate limiting Offbeat', Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null);
  }
  if (res.status === 401 || res.status === 404) {
    throw new PermanentError('Discord does not know this webhook. It may have been deleted; paste a new one.');
  }
  if (!res.ok) throw new RetryableError(`Discord answered HTTP ${res.status}`);
}

/** Generic webhook: the documented JSON payload, signed when a secret is set. */
export async function sendWebhook(url: string, secret: string | null, { payload }: Message): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers['x-offbeat-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const res = await post(url, body, headers);
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    throw new PermanentError(`The webhook answered HTTP ${res.status}`);
  }
  if (!res.ok) throw new RetryableError(`The webhook answered HTTP ${res.status}`);
}

async function post(url: string, body: string, headers: Record<string, string>): Promise<Response> {
  const why = await unsafeUrl(url);
  if (why) throw new PermanentError(why);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'user-agent': USER_AGENT },
      body,
      redirect: 'error', // a redirect could lead somewhere the check above never saw
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not connect';
    throw new RetryableError(`The request ${reason}`);
  }
}
