import {
  type CurrentUser,
  DEFAULT_MEMBER_PERMISSIONS,
  DEFAULT_SIGN_IN,
  type SignInSettings,
  type SignInVia,
  USERNAME_PATTERN,
} from '@offbeat/shared';
import { eq, sql } from 'drizzle-orm';
import type { BlockList } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import type { SettingsStore } from '../settings/store.js';
import { type ClientAddress, blockListOf, clientAddress, contains, dockerStandIns, parseRange } from './network.js';
import { hashPassword } from './password.js';
import { toCurrentUser } from './permissions.js';
import { touchLastSeen } from './sessions.js';

const KEY = 'sign-in';

const range = z.string().trim().refine((t) => parseRange(t) !== null, 'not an address or CIDR range');
export const signInSchema = z.object({
  localAccounts: z.boolean(),
  proxy: z.object({
    enabled: z.boolean(),
    header: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,64}$/, 'use a header name like Remote-User'),
    trustedProxies: z.array(range).max(32),
    autoCreate: z.boolean(),
    logoutUrl: z
      .string()
      .trim()
      .url('use a full address, like https://auth.example.com/logout')
      .refine((u) => /^https?:\/\//i.test(u), 'use an http or https address')
      .nullable(),
    secretHeader: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,64}$/, 'use a header name like X-Offbeat-Proxy-Secret')
      .default('X-Offbeat-Proxy-Secret'),
    secret: z
      .string()
      .trim()
      .refine((s) => s === '' || s.length >= 16, 'use at least 16 characters (Generate makes a strong one)')
      .max(256)
      .nullable()
      .default(null),
  }),
  autoLogin: z.object({
    enabled: z.boolean(),
    userId: z.number().int().positive().nullable(),
    networks: z.array(range).max(32),
  }),
});

interface Compiled {
  settings: SignInSettings;
  trusted: BlockList;
  local: BlockList;
}

const cache = new WeakMap<SettingsStore, Compiled>();
/** Docker addresses that stand for anyone (see dockerStandIns); found once at startup. */
let standIns: string[] = [];

export async function findDockerStandIns(find = dockerStandIns) {
  standIns = await find();
}

export function dockerStandInAddresses(): string[] {
  return standIns;
}

function compiled(store: SettingsStore): Compiled {
  let entry = cache.get(store);
  if (!entry) {
    const settings = store.get(KEY, signInSchema) ?? DEFAULT_SIGN_IN;
    entry = { settings, trusted: blockListOf(settings.proxy.trustedProxies), local: blockListOf(settings.autoLogin.networks) };
    cache.set(store, entry);
  }
  return entry;
}

export function loadSignIn(store: SettingsStore): SignInSettings {
  return compiled(store).settings;
}

/** Saves the settings; a null secret keeps the saved one, "" clears it. Stored encrypted (the secret is in it). */
export function saveSignIn(store: SettingsStore, settings: SignInSettings) {
  const secret = settings.proxy.secret === null ? loadSignIn(store).proxy.secret : settings.proxy.secret || null;
  store.set(KEY, { ...settings, proxy: { ...settings.proxy, secret } }, { encrypted: true });
  cache.delete(store);
}

/** The settings as the browser may see them: never the secret itself. */
export function signInForBrowser(store: SettingsStore): SignInSettings & { proxySecretSet: boolean } {
  const settings = loadSignIn(store);
  return { ...settings, proxy: { ...settings.proxy, secret: null }, proxySecretSet: !!settings.proxy.secret };
}

/** Whether a request carries the proxy's shared secret, when one is set (constant-time compare). */
function hasProxySecret(settings: SignInSettings, headers: Record<string, string | string[] | undefined>): boolean {
  const expected = settings.proxy.secret;
  if (!expected) return true;
  const raw = headers[settings.proxy.secretHeader.toLowerCase()];
  const sent = Array.isArray(raw) ? raw[0] : raw;
  if (!sent) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function addressOf(store: SettingsStore, socket: string | undefined, headers: Record<string, string | string[] | undefined>) {
  return clientAddress(socket, headers, compiled(store).trusted);
}

/**
 * Whether this request is really from the local network. Anything that
 * cannot be verified is not: forwarding headers from something that is not a
 * trusted proxy, a trusted proxy that did not say who the client is, a
 * trusted proxy itself, and Docker addresses that stand for anyone.
 */
export function isLocal(address: ClientAddress, local: BlockList, trusted: BlockList): boolean {
  if (address.untrustedForwarding || !address.client) return false;
  if (standIns.includes(address.client) || contains(trusted, address.client)) return false;
  return contains(local, address.client);
}

export interface Identity {
  user: CurrentUser | null;
  via: SignInVia | null;
  unknownProxyUser: string | null;
}

/**
 * Who the proxy header or the local network says this is, when those are
 * enabled. `null` means neither applies, so the session cookie decides.
 */
export async function identityFromNetwork(
  db: Db,
  store: SettingsStore,
  socket: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): Promise<Identity | 'proxy-silent' | null> {
  const { settings, trusted } = compiled(store);
  const address = clientAddress(socket, headers, trusted);

  if (settings.proxy.enabled && address.viaTrustedProxy) {
    // Without the shared secret (when one is set), the username is not the proxy's word: ignore it.
    if (!hasProxySecret(settings, headers)) return 'proxy-silent';
    const raw = headers[settings.proxy.header.toLowerCase()];
    const name = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    // A trusted proxy that sent no username (a path it does not protect): fall back to the session.
    if (!name) return 'proxy-silent';
    const row = db.select().from(users).where(sql`${users.username} = ${name} collate nocase`).get();
    if (row) {
      touchLastSeen(db, row);
      return { user: toCurrentUser(row), via: 'proxy', unknownProxyUser: null };
    }
    if (settings.proxy.autoCreate && USERNAME_PATTERN.test(name)) {
      const created = await createProxyMember(db, name);
      if (created) return { user: toCurrentUser(created), via: 'proxy', unknownProxyUser: null };
    }
    return { user: null, via: null, unknownProxyUser: name };
  }
  // Not through the proxy: the session cookie decides, then auto-login (autoLoginUser).
  return null;
}

/** The auto-login user for a request from the local network, or null. Never an admin. */
export function autoLoginUser(
  db: Db,
  store: SettingsStore,
  socket: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): CurrentUser | null {
  const { settings, trusted, local } = compiled(store);
  if (!settings.autoLogin.enabled || !settings.autoLogin.userId) return null;
  if (!isLocal(clientAddress(socket, headers, trusted), local, trusted)) return null;
  const row = db.select().from(users).where(eq(users.id, settings.autoLogin.userId)).get();
  if (!row || row.role === 'admin') return null;
  touchLastSeen(db, row);
  return toCurrentUser(row);
}

/** A Member for a username the proxy vouched for. Never an admin; the password is random and unknown. */
async function createProxyMember(db: Db, username: string) {
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  return db
    .insert(users)
    .values({ username, passwordHash, role: 'user', permissions: JSON.stringify(DEFAULT_MEMBER_PERMISSIONS), lastSeenAt: new Date() })
    .onConflictDoNothing()
    .returning()
    .get();
}
