import type { FastifyBaseLogger } from 'fastify';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { Discovery, type DiscoverySources } from '../src/discovery/discovery.js';
import { SourceCache } from '../src/discovery/source-cache.js';
import type { LastfmClient } from '../src/integrations/lastfm/client.js';
import type { LidarrClient } from '../src/integrations/lidarr/client.js';
import type { ListenBrainzClient } from '../src/integrations/listenbrainz/client.js';
import { ImageUrls } from '../src/library/image-urls.js';
import type { Library } from '../src/library/library.js';

const silentLog = { debug() {}, info() {}, warn() {} } as unknown as FastifyBaseLogger;
const id = (name: string) => `00000000-0000-4000-8000-${name.padEnd(12, '0').slice(0, 12).replace(/[^0-9a-f]/g, 'a')}`;

/** A tiny world: NOFX in the library, punk bands around it. */
const SIMILAR: Record<string, [string, number][]> = {
  NOFX: [['Lagwagon', 3000], ['Rancid', 2800], ['No Use for a Name', 1500]],
  Lagwagon: [['Strung Out', 2000], ['Rancid', 1500]],
  Rancid: [['Operation Ivy', 2200]],
  'No Use for a Name': [['Strung Out', 900]],
};
const NAMES = ['NOFX', 'Lagwagon', 'Rancid', 'No Use for a Name', 'Strung Out', 'Operation Ivy', 'Mad Caddies', 'Face to Face'];
/** A different, obscure band with the same name, whose MBID Last.fm wrongly gives. */
const WRONG_FACE_TO_FACE = '00000000-0000-4000-8000-0000bad0fa11';
const byId = new Map(NAMES.map((n) => [id(n), n]));

function setup({ lastfm = false, listenbrainzFails = false } = {}) {
  const db = openDatabase(':memory:');
  const user = db.insert(users).values({ username: 'sam', passwordHash: 'x', role: 'admin', lastfmUsername: lastfm ? 'sam' : null }).returning().get();
  const library = { read: () => ({ artists: [{ mbid: id('NOFX'), name: 'NOFX' }] }) } as unknown as Library;
  const listenbrainz = {
    similarArtists: vi.fn(async (mbid: string) => {
      if (listenbrainzFails) throw new Error('ListenBrainz is down');
      return (SIMILAR[byId.get(mbid) ?? ''] ?? []).map(([name, score]) => ({ mbid: id(name), name, score }));
    }),
    popularity: vi.fn(async (mbids: string[]) => new Map(mbids.map((m) => [m, byId.get(m) === 'Rancid' ? 900_000 : 2_000]))),
    userTopArtists: vi.fn(async () => []),
  } as unknown as ListenBrainzClient;
  const lastfmClient = {
    // Last.fm knows Mad Caddies by name only, and adds weight to Lagwagon.
    similarArtists: vi.fn(async ({ name }: { name: string }) =>
      name === 'NOFX'
        ? [
            { mbid: id('Lagwagon'), name: 'Lagwagon', match: 1 },
            { mbid: null, name: 'Mad Caddies', match: 0.9 },
            { mbid: WRONG_FACE_TO_FACE, name: 'Face to Face', match: 0.8 },
          ]
        : [],
    ),
    userTopArtists: vi.fn(async () => [{ mbid: id('Rancid'), name: 'Rancid', plays: 50 }]),
  } as unknown as LastfmClient;
  const lookups: string[] = [];
  const lidarr = {
    lookupArtists: vi.fn(async (term: string) => {
      lookups.push(term);
      const name = term.startsWith('lidarr:') ? byId.get(term.slice(7)) : NAMES.find((n) => n.toLowerCase() === term.toLowerCase());
      if (!name) return [];
      return [
        {
          artistName: name,
          foreignArtistId: id(name),
          disambiguation: '',
          genres: ['Punk', 'Skate Punk'],
          images: [{ coverType: 'poster', remoteUrl: `https://images.lidarr.audio/cache/${encodeURIComponent(name)}.jpg` }],
        },
      ];
    }),
  } as unknown as LidarrClient;
  const sources: DiscoverySources = { listenbrainz, lastfm: () => (lastfm ? lastfmClient : null), lidarr: () => lidarr };
  const discovery = new Discovery(db, library, sources, new ImageUrls(randomBytes(32)), silentLog, { schedule: null });
  return { db, discovery, userId: user.id, listenbrainz, lastfmClient, lookups };
}

describe('Discovery', () => {
  it('works with ListenBrainz alone: stores every mode, never recommends the library, and adds artwork from Lidarr', async () => {
    const { discovery, userId } = setup();
    await discovery.refresh(userId);
    const balanced = discovery.read(userId, 'balanced');
    expect(balanced.generatedAt).not.toBeNull();
    expect(balanced.sources).toEqual({ listenbrainz: true, lastfm: false });
    // Rancid co-occurs a lot, but it is also far more popular (900,000 listeners here), so the
    // popularity correction ranks it below the bands specifically played next to NOFX.
    expect(balanced.items.map((i) => i.name)).toEqual(['Lagwagon', 'No Use for a Name', 'Rancid']);
    expect(balanced.items.map((i) => i.name)).not.toContain('NOFX');
    expect(balanced.items[0]).toMatchObject({
      reason: { seed: 'NOFX', via: null },
      genres: ['Punk', 'Skate Punk'],
      sources: ['listenbrainz'],
    });
    expect(balanced.items[0]!.imageUrl).toMatch(/^api\/v1\/images\/remote\?u=/);
    // Deeper reaches second hops, and explains them through the artist they came from.
    const deeper = discovery.read(userId, 'deeper').items;
    expect(deeper.find((i) => i.name === 'Operation Ivy')?.reason).toMatchObject({ seed: 'NOFX', via: 'Rancid' });
    expect(discovery.read(userId, 'safer').items.map((i) => i.name)).not.toContain('Operation Ivy');
  });

  it('with Last.fm: blends both sources, resolves names without an MBID through Lidarr, and seeds from plays', async () => {
    const { discovery, userId, lookups } = setup({ lastfm: true });
    await discovery.refresh(userId);
    const balanced = discovery.read(userId, 'balanced');
    expect(balanced.sources.lastfm).toBe(true);
    expect(balanced.seedCount).toBe(2); // NOFX from the library, Rancid from Last.fm plays
    const names = balanced.items.map((i) => i.name);
    expect(names).toContain('Mad Caddies'); // resolved by exact name
    expect(names).not.toContain('Rancid'); // a seed now, so not a recommendation
    expect(lookups).toContain('Mad Caddies');
    expect(balanced.items.find((i) => i.name === 'Lagwagon')?.sources).toEqual(['lastfm', 'listenbrainz']);
    // Last.fm pointed Face to Face at the wrong band; the name check through Lidarr fixed it.
    const faceToFace = balanced.items.find((i) => i.name === 'Face to Face');
    expect(faceToFace?.mbid).toBe(id('Face to Face'));
    expect(balanced.items.map((i) => i.mbid)).not.toContain(WRONG_FACE_TO_FACE);
    // Both sources agree on Lagwagon, so it is near the top (refreshes vary the order a little).
    expect(names.slice(0, 2)).toContain('Lagwagon');
  });

  it('caches upstream answers between refreshes', async () => {
    const { discovery, userId, listenbrainz } = setup();
    await discovery.refresh(userId);
    const calls = vi.mocked(listenbrainz.similarArtists).mock.calls.length;
    await discovery.refresh(userId);
    expect(vi.mocked(listenbrainz.similarArtists).mock.calls.length).toBe(calls);
  });

  it('reports a failed refresh and keeps what it had', async () => {
    const { discovery, userId } = setup({ listenbrainzFails: true });
    await discovery.refresh(userId);
    // Nothing similar came back: an empty but successful refresh, not a crash.
    expect(discovery.read(userId, 'balanced')).toMatchObject({ items: [], error: null });
  });
});

describe('SourceCache', () => {
  it('serves the stale copy when the source fails', async () => {
    const cache = new SourceCache(openDatabase(':memory:'), silentLog);
    await cache.get('k', 60_000, async () => 'fresh');
    expect(await cache.get('k', 0, async () => Promise.reject(new Error('down')))).toBe('fresh');
    await expect(cache.get('other', 0, async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
  });
});

describe('discover routes', () => {
  it('starts the first refresh on first visit, refreshes on demand, and needs a session', async () => {
    const { buildApp } = await import('../src/app.js');
    const { tmpImageDir } = await import('./helpers.js');
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
    const refresh = vi.spyOn(app.discovery, 'refresh').mockResolvedValue();
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'sam', password: randomBytes(12).toString('base64url') } });
      const headers = { cookie: `offbeat_session=${setup.cookies.find((c) => c.name === 'offbeat_session')?.value}` };

      const first = await app.inject({ method: 'GET', url: '/api/v1/discover?mode=deeper', headers });
      expect(first.json()).toMatchObject({ mode: 'deeper', generatedAt: null, refreshing: true, items: [] });
      expect(refresh).toHaveBeenCalledTimes(1);

      expect((await app.inject({ method: 'POST', url: '/api/v1/discover/refresh', headers, payload: {} })).statusCode).toBe(202);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect((await app.inject({ method: 'GET', url: '/api/v1/discover?mode=loud', headers })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/v1/discover' })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
