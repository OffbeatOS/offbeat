import { existsSync, readFileSync } from 'node:fs';
import { lookup as lookupHost } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Where a request really came from, for proxy header auth and local network
 * auto-login. Never trusts a forwarding header unless the connection itself
 * comes from a configured trusted proxy; anything that cannot be verified is
 * treated as not local.
 */

/** `::ffff:192.168.1.5` is 192.168.1.5. */
export function normalizeAddress(address: string | undefined | null): string | null {
  if (!address) return null;
  const trimmed = address.trim().replace(/^\[|\]$/g, '');
  const mapped = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const plain = mapped ? mapped[1]! : trimmed;
  return isIP(plain) ? plain : null;
}

export interface ParsedRange {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/** "192.168.1.0/24", "10.0.0.5", "fd00::/8". Returns null for anything else. */
export function parseRange(text: string): ParsedRange | null {
  const [raw, bits, extra] = text.trim().split('/');
  if (extra !== undefined) return null;
  const address = normalizeAddress(raw);
  if (!address) return null;
  const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
  const max = family === 'ipv4' ? 32 : 128;
  if (bits !== undefined && !/^\d{1,3}$/.test(bits)) return null;
  const prefix = bits === undefined ? max : Number(bits);
  if (prefix > max) return null;
  return { address, prefix, family };
}

export function blockListOf(ranges: string[]): BlockList {
  const list = new BlockList();
  for (const text of ranges) {
    const range = parseRange(text);
    if (range) list.addSubnet(range.address, range.prefix, range.family);
  }
  return list;
}

export function contains(list: BlockList, address: string | null): boolean {
  if (!address) return false;
  return list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

export interface ClientAddress {
  /** The other end of the TCP connection. */
  socket: string | null;
  /** The connection came from a configured trusted proxy. */
  viaTrustedProxy: boolean;
  /**
   * The real client: the socket address, or through a trusted proxy the last
   * X-Forwarded-For entry not itself a trusted proxy. Null when it cannot be
   * known (a trusted proxy that sent no usable X-Forwarded-For).
   */
  client: string | null;
  /** Forwarding headers arrived from something that is not a trusted proxy (so the socket may be a proxy nobody declared). */
  untrustedForwarding: boolean;
}

export function clientAddress(
  socketAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  trusted: BlockList,
): ClientAddress {
  const socket = normalizeAddress(socketAddress);
  const forwarded = [headers['x-forwarded-for']].flat().filter(Boolean).join(',');
  const hasForwarding = !!forwarded || !!headers['forwarded'] || !!headers['x-real-ip'];
  if (!contains(trusted, socket)) {
    return { socket, viaTrustedProxy: false, client: socket, untrustedForwarding: hasForwarding };
  }
  // Walk from the right: the nearest hops are proxies we trust; the first one that is not is the client.
  const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean).reverse();
  for (const hop of hops) {
    const address = normalizeAddress(hop);
    if (!address) return { socket, viaTrustedProxy: true, client: null, untrustedForwarding: false };
    if (!contains(trusted, address)) return { socket, viaTrustedProxy: true, client: address, untrustedForwarding: false };
  }
  return { socket, viaTrustedProxy: true, client: null, untrustedForwarding: false };
}

const DOCKER_ENV = '/.dockerenv';

/**
 * Addresses that stand for anyone inside Docker: connections through a
 * published port can arrive from them whoever made them. The bridge network's
 * gateway, and on Docker Desktop its VM gateway (for example 192.168.65.1,
 * named gateway.docker.internal). Empty outside Docker. On Linux with the
 * default port publishing, real client addresses come through and are fine.
 */
export async function dockerStandIns(
  lookup: (host: string) => Promise<string | null> = resolveHost,
  routeFile = '/proc/net/route',
  dockerEnv = DOCKER_ENV,
): Promise<string[]> {
  if (!existsSync(dockerEnv)) return [];
  const found = new Set<string>();
  const gateway = dockerGateway(routeFile, dockerEnv);
  if (gateway) found.add(gateway);
  for (const host of ['gateway.docker.internal', 'host.docker.internal']) {
    const address = normalizeAddress(await lookup(host));
    if (address) found.add(address);
  }
  return [...found];
}

async function resolveHost(host: string): Promise<string | null> {
  try {
    return (await lookupHost(host)).address;
  } catch {
    return null;
  }
}

/**
 * Inside Docker, connections through a published port can arrive from the
 * bridge network's gateway (for example 172.17.0.1), whoever made them. That
 * address must never count as local. Null outside Docker.
 */
export function dockerGateway(routeFile = '/proc/net/route', dockerEnv = DOCKER_ENV): string | null {
  if (!existsSync(dockerEnv) || !existsSync(routeFile)) return null;
  for (const line of readFileSync(routeFile, 'utf8').split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination === '00000000' && gateway && gateway !== '00000000') {
      // Little-endian hex, for example 0100A8C0 is 192.168.0.1.
      const bytes = gateway.match(/../g)!.map((b) => parseInt(b, 16)).reverse();
      return bytes.join('.');
    }
  }
  return null;
}
