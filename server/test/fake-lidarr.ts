import { randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';

export interface FakeLidarr {
  url: string;
  apiKey: string;
  /** Every request path the fake received, for asserting what was called. */
  requests: string[];
  /** Requests that arrived without the API key (should stay empty). */
  unauthenticated: string[];
  close(): Promise<void>;
}

export interface FakeLidarrOptions {
  urlBase?: string;
  mode?: 'ok' | 'hang' | 'html' | 'sonarr';
  /** Number of generated artists (default 0). */
  artists?: number;
  port?: number;
  /** Pin the key, for the dev runner. Tests get a random one. */
  apiKey?: string;
}

const FIRST = ['Silver', 'Velvet', 'Hollow', 'Neon', 'Quiet', 'Paper', 'Golden', 'Static', 'Wild', 'Glass', 'Low', 'Pale', 'Echo', 'Night', 'Salt', 'Iron', 'Soft', 'Blue', 'Burning', 'Distant'];
const SECOND = ['Harbor', 'Tides', 'Engines', 'Owls', 'Motel', 'Parade', 'Signals', 'Gardens', 'Rivers', 'Machines', 'Choir', 'Weather', 'Lanterns', 'Saints', 'Ghosts', 'Arcade', 'Coast', 'Horses', 'Radio', 'Cathedral'];
const GENRES = ['Ambient', 'Shoegaze', 'Post-Rock', 'Electronic', 'Indie Rock', 'Jazz', 'Folk', 'Dream Pop'];

/** Deterministic fake artists: "The" prefixes, varied monitoring, some without artwork. */
export function fakeArtists(count: number) {
  const now = Date.parse('2026-09-01T00:00:00Z');
  return Array.from({ length: count }, (_, i) => {
    const base = `${FIRST[i % FIRST.length]} ${SECOND[Math.floor(i / FIRST.length) % SECOND.length]}`;
    const cycle = Math.floor(i / (FIRST.length * SECOND.length));
    const plain = cycle ? `${base} ${cycle + 1}` : base;
    const name = i % 7 === 0 ? `The ${plain}` : plain;
    const id = i + 1;
    const hasArt = i % 11 !== 0;
    return {
      id,
      artistName: name,
      sortName: plain.toLowerCase(),
      foreignArtistId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      monitored: i % 9 !== 0,
      added: new Date(now - i * 3_600_000).toISOString(),
      genres: [GENRES[i % GENRES.length]],
      images: hasArt
        ? [{ coverType: 'poster', url: `/MediaCover/Artists/${id}/poster.png?lastWrite=638600000000000000` }]
        : [],
      statistics: { albumCount: (i % 6) + 1, trackCount: 40, trackFileCount: 30, sizeOnDisk: (i + 1) * 250_000_000 },
    };
  });
}

/**
 * A minimal stand-in for Lidarr's API on a local port. `urlBase` mimics
 * Lidarr's URL Base setting; `mode` simulates misbehaving servers. Like real
 * Lidarr, MediaCover artwork requires the API key.
 */
export async function startFakeLidarr(options: FakeLidarrOptions = {}): Promise<FakeLidarr> {
  const { urlBase = '', mode = 'ok', artists: artistCount = 0, port = 0 } = options;
  const apiKey = options.apiKey ?? randomBytes(16).toString('hex');
  const requests: string[] = [];
  const unauthenticated: string[] = [];
  const artists = fakeArtists(artistCount);
  // Every fourth artist has missing albums (1 to 3 of them).
  const missing = artists.flatMap((a, i) => (i % 4 === 0 ? Array.from({ length: (i % 3) + 1 }, () => ({ artistId: a.id })) : []));

  const routes: Record<string, unknown> = {
    'system/status': { appName: mode === 'sonarr' ? 'Sonarr' : 'Lidarr', version: '3.1.0.4875' },
    qualityprofile: [
      { id: 2, name: 'Lossless' },
      { id: 1, name: 'Any' },
    ],
    metadataprofile: [{ id: 1, name: 'Standard' }],
    rootfolder: [
      { id: 1, path: '/music', freeSpace: 1_000_000, defaultQualityProfileId: 2, defaultMetadataProfileId: 1 },
    ],
    artist: artists,
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    requests.push(req.url ?? '');
    if (mode === 'hang') return; // never answer
    if (mode === 'html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Some app</title>');
      return;
    }
    const authorized = req.headers['x-api-key'] === apiKey || url.searchParams.get('apikey') === apiKey;
    if (!authorized) unauthenticated.push(req.url ?? '');

    const cover = url.pathname.match(new RegExp(`^${urlBase}/MediaCover/Artists/(\\d+)/poster(-\\d+)?\\.png$`));
    if (cover) {
      if (!authorized) return void res.writeHead(401).end();
      const id = Number(cover[1]);
      if (!artists.some((a) => a.id === id && a.images.length)) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'image/png' }).end(solidPng(id));
      return;
    }

    const prefix = `${urlBase}/api/v1/`;
    if (!url.pathname.startsWith(prefix)) return void res.writeHead(404).end();
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized"}');
      return;
    }
    const route = url.pathname.slice(prefix.length);
    if (route === 'wanted/missing') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 10);
      const records = missing.slice((page - 1) * pageSize, page * pageSize);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ page, pageSize, totalRecords: missing.length, records }));
      return;
    }
    const body = routes[route];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}${urlBase}`,
    apiKey,
    requests,
    unauthenticated,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A 32x32 PNG in a muted color derived from `seed`. */
function solidPng(seed: number): Buffer {
  const size = 32;
  const hue = (seed * 47) % 360;
  const [r, g, b] = hslToRgb(hue, 0.25, 0.32);
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number];
}
