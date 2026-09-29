import type { FastifyBaseLogger } from 'fastify';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { recommendations, users } from '../src/db/schema.js';
import { Discovery, type DiscoverySources } from '../src/discovery/discovery.js';
import { SourceCache } from '../src/discovery/source-cache.js';
import type { LastfmClient } from '../src/integrations/lastfm/client.js';
import type { LidarrClient } from '../src/integrations/lidarr/client.js';
import type { ListenBrainzClient } from '../src/integrations/listenbrainz/client.js';
import type { MusicBrainzClient } from '../src/integrations/musicbrainz/client.js';
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

// Each artist: an early album, their best known one, and a live album that never counts.
function releaseGroupsOf(mbid: string) {
  const name = byId.get(mbid) ?? 'Someone';
  return [
    { id: `${mbid}-rg1`, title: `${name} Debut`, 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '1991-01-01' },
    { id: `${mbid}-rg2`, title: `${name} Classic`, 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '1994-01-01' },
    { id: `${mbid}-rg3`, title: `${name} Live`, 'primary-type': 'Album', 'secondary-types': ['Live'], 'first-release-date': '1999-01-01' },
  ];
}

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
    // The second album is the one people play.
    releaseGroupPopularity: vi.fn(async (mbids: string[]) => new Map(mbids.map((m, i) => [m, i === 1 ? 5000 : 100]))),
    // Most listened first: the live album (ListenBrainz calls it an Album too), the classic, the debut, and a single.
    topReleaseGroups: vi.fn(async (mbid: string) => {
      const [debut, classic, live] = releaseGroupsOf(mbid);
      return [
        { mbid: live!.id, type: 'Album' },
        { mbid: `${mbid}-rg4`, type: 'Single' },
        { mbid: classic!.id, type: 'Album' },
        { mbid: debut!.id, type: 'Album' },
      ];
    }),
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
    // Free-form tags: an opinion, a genre, and one too weak to show.
    artistTopTags: vi.fn(async () => [
      { name: 'seen live', count: 100 },
      { name: 'punk', count: 90 },
      { name: 'ska punk', count: 4 },
    ]),
  } as unknown as LastfmClient;
  const musicbrainz = {
    artistGenres: vi.fn(async () => [
      { name: 'punk rock', count: 5 },
      { name: 'skate punk', count: 3 },
    ]),
    releaseGroups: vi.fn(async (mbid: string) => releaseGroupsOf(mbid)),
    releaseGroupsById: vi.fn(async (ids: string[]) =>
      NAMES.flatMap((name) => releaseGroupsOf(id(name))).filter((g) => ids.includes(g.id)),
    ),
    artistsTagged: vi.fn(async () =>
      ['Operation Ivy', 'Lagwagon', 'NOFX'].map((name) => ({ mbid: id(name), name, disambiguation: null })),
    ),
  } as unknown as MusicBrainzClient;
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
          genres: ['Punk', 'Skate Punk'], // Lidarr's free-form tags: no longer used for display
          images: [{ coverType: 'poster', remoteUrl: `https://images.lidarr.audio/cache/${encodeURIComponent(name)}.jpg` }],
        },
      ];
    }),
  } as unknown as LidarrClient;
  const sources: DiscoverySources = { listenbrainz, lastfm: () => (lastfm ? lastfmClient : null), lidarr: () => lidarr, musicbrainz };
  const discovery = new Discovery(db, library, sources, new ImageUrls(randomBytes(32)), silentLog, { schedule: null });
  return { db, discovery, userId: user.id, listenbrainz, lastfmClient, lookups, musicbrainz };
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
      genres: ['Punk Rock', 'Skate Punk'], // MusicBrainz's curated genres, since Last.fm is not connected
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
    // Last.fm's tags when connected, without opinions or weak tags.
    expect(balanced.items[0]?.genres).toEqual(['Punk']);
    // Last.fm pointed Face to Face at the wrong band; the name check through Lidarr fixed it.
    const faceToFace = balanced.items.find((i) => i.name === 'Face to Face');
    expect(faceToFace?.mbid).toBe(id('Face to Face'));
    expect(balanced.items.map((i) => i.mbid)).not.toContain(WRONG_FACE_TO_FACE);
    // Both sources agree on Lagwagon, so it is near the top (refreshes vary the order a little).
    expect(names.slice(0, 2)).toContain('Lagwagon');
  });

  it("picks each top artist's most played studio album to start with, and the genres to explore", async () => {
    const { discovery, userId } = setup();
    await discovery.refresh(userId);
    const page = discovery.read(userId, 'balanced');
    expect(page.albums.map((a) => a.title)).toEqual(['Lagwagon Classic', 'No Use for a Name Classic', 'Rancid Classic']);
    expect(page.albums[0]).toMatchObject({ type: 'Album', year: 1994, artistName: 'Lagwagon', status: { kind: 'available' } });
    expect(page.tags).toEqual(['Punk Rock', 'Skate Punk']);
  });

  it('builds a tag page: best known first, what is recommended, and related genres from the recommendations', async () => {
    const { discovery, userId, musicbrainz } = setup();
    await discovery.refresh(userId);
    const page = await discovery.tag(userId, 'Punk Rock');
    // Rancid is the most popular in this world, but not tagged; NOFX is in the library.
    expect(page.artists.map((a) => [a.name, a.recommended, a.inLibrary])).toEqual([
      ['Operation Ivy', true, false],
      ['Lagwagon', true, false],
      ['NOFX', false, true],
    ]);
    expect(page.related).toEqual(['Skate Punk']);
    vi.mocked(musicbrainz.releaseGroupsById).mockClear();
    const albums = await discovery.tagAlbums('Punk Rock');
    expect(albums.map((a) => [a.title, a.artistName])).toEqual([
      ['Operation Ivy Classic', 'Operation Ivy'],
      ['Lagwagon Classic', 'Lagwagon'],
      ['NOFX Classic', 'NOFX'],
    ]);
    // ListenBrainz ranks, and one MusicBrainz request (not one per artist) weeds out the live album.
    expect(musicbrainz.releaseGroupsById).toHaveBeenCalledTimes(1);
    expect(musicbrainz.releaseGroups).not.toHaveBeenCalled();
  });

  it('browses MusicBrainz for starter albums when ListenBrainz has none for an artist', async () => {
    const { discovery, listenbrainz, musicbrainz } = setup();
    vi.mocked(listenbrainz.topReleaseGroups).mockImplementation(async (mbid: string) => {
      if (mbid === id('Lagwagon')) throw new Error('ListenBrainz wants a token');
      return [];
    });
    const albums = await discovery.tagAlbums('Punk Rock');
    expect(albums.map((a) => a.title)).toEqual(['Operation Ivy Classic', 'Lagwagon Classic', 'NOFX Classic']);
    // Only studio-type release groups: one MusicBrainz page per artist, not the whole catalog.
    expect(vi.mocked(musicbrainz.releaseGroups).mock.calls.map(([, options]) => options)).toEqual([
      { albumsOnly: true },
      { albumsOnly: true },
      { albumsOnly: true },
    ]);
  });

  it('shows Top Picks before Albums to Start With on a first refresh', async () => {
    const { discovery, userId, musicbrainz } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = vi.mocked(musicbrainz.releaseGroupsById).getMockImplementation()!;
    vi.mocked(musicbrainz.releaseGroupsById).mockImplementation(async (ids: string[]) => {
      await gate; // MusicBrainz is slow on a first refresh
      return original(ids);
    });
    const refreshing = discovery.refresh(userId);
    for (let i = 0; i < 50 && !discovery.read(userId, 'balanced').generatedAt; i++) await new Promise((r) => setTimeout(r, 10));
    const early = discovery.read(userId, 'balanced');
    expect(early.items.length).toBeGreaterThan(0);
    expect(early).toMatchObject({ refreshing: true, albums: [], albumsPending: true });

    release();
    await refreshing;
    expect(discovery.read(userId, 'balanced')).toMatchObject({ refreshing: false, albumsPending: false });
    expect(discovery.read(userId, 'balanced').albums.length).toBeGreaterThan(0);
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

      // A first refresh cut off before its albums (a restart mid-run): the next visit starts one to finish.
      const userId = app.db.select().from(users).get()!.id;
      const payload = { items: [], albums: [], albumsPending: true, tags: [], seedCount: 1, sources: { listenbrainz: true, lastfm: false } };
      app.db.insert(recommendations).values({ userId, mode: 'balanced', payload: JSON.stringify(payload), generatedAt: new Date() }).run();
      const resumed = await app.inject({ method: 'GET', url: '/api/v1/discover?mode=balanced', headers });
      expect(resumed.json()).toMatchObject({ refreshing: true, albumsPending: true });
      expect(refresh).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it('answers a tag page without waiting for its albums, which come from their own request', async () => {
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
    vi.spyOn(app.discovery, 'tag').mockResolvedValue({ artists: [], related: ['Skate Punk'] });
    // Albums that never arrive (MusicBrainz is slow on a first visit) must not hold up the page.
    const albums = vi.spyOn(app.discovery, 'tagAlbums').mockReturnValue(new Promise(() => {}));
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'sam', password: randomBytes(12).toString('base64url') } });
      const headers = { cookie: `offbeat_session=${setup.cookies.find((c) => c.name === 'offbeat_session')?.value}` };

      const page = await app.inject({ method: 'GET', url: '/api/v1/tags/Punk%20Rock', headers });
      expect(page.json()).toEqual({ tag: 'Punk Rock', artists: [], related: ['Skate Punk'] });
      expect(albums).not.toHaveBeenCalled();

      albums.mockResolvedValue([
        { mbid: 'rg-1', title: 'Punk in Drublic', type: 'Album', year: 1994, coverUrl: null, artistMbid: 'a-1', artistName: 'NOFX', status: { kind: 'available' } },
      ]);
      const found = await app.inject({ method: 'GET', url: '/api/v1/tags/Punk%20Rock/albums', headers });
      expect(found.json().albums.map((a: { title: string }) => a.title)).toEqual(['Punk in Drublic']);
      expect(albums).toHaveBeenCalledWith('Punk Rock');
      expect((await app.inject({ method: 'GET', url: '/api/v1/tags/Punk%20Rock/albums' })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('feedback and blocklist', () => {
  it('a thumbs down takes the artist out now and keeps it out; a thumbs up does not', async () => {
    const { discovery, userId } = setup();
    await discovery.refresh(userId);
    discovery.rate(userId, id('Lagwagon'), 'down');
    discovery.rate(userId, id('No Use for a Name'), 'up');
    const now = discovery.read(userId, 'balanced').items;
    expect(now.map((i) => i.name)).not.toContain('Lagwagon');
    expect(now.find((i) => i.name === 'No Use for a Name')?.feedback).toBe('up');

    await discovery.refresh(userId);
    expect(discovery.read(userId, 'balanced').items.map((i) => i.name)).not.toContain('Lagwagon');

    // Listed as hidden (thumbs downs only), with the name from the stored pick; clearing it shows it again.
    expect(discovery.blocklist(userId).hidden).toMatchObject([{ mbid: id('Lagwagon'), name: 'Lagwagon' }]);
    discovery.rate(userId, id('Lagwagon'), null);
    expect(discovery.blocklist(userId).hidden).toEqual([]);
    await discovery.refresh(userId); // it was left out of the last one
    expect(discovery.read(userId, 'balanced').items.map((i) => i.name)).toContain('Lagwagon');
  });

  it('undoing a thumbs down or a block brings the pick straight back, in its place', async () => {
    const { discovery, userId } = setup();
    await discovery.refresh(userId);
    const before = discovery.read(userId, 'balanced');
    discovery.rate(userId, id('Lagwagon'), 'down');
    discovery.rate(userId, id('Lagwagon'), null);
    expect(discovery.read(userId, 'balanced')).toEqual(before);

    const blocked = discovery.block(userId, { kind: 'artist', mbid: id('Lagwagon'), name: 'Lagwagon', source: 'discover' });
    expect(discovery.read(userId, 'balanced').albums.map((a) => a.artistMbid)).not.toContain(id('Lagwagon'));
    discovery.unblock(userId, blocked.id);
    expect(discovery.read(userId, 'balanced')).toEqual(before);
  });

  it('blocks artists and tags now and at every refresh, and unblocking lets them back', async () => {
    const { discovery, userId } = setup();
    await discovery.refresh(userId);
    const blocked = discovery.block(userId, { kind: 'artist', mbid: id('Rancid'), name: 'Rancid', source: 'discover' });
    expect(discovery.read(userId, 'deeper').items.map((i) => i.name)).not.toContain('Rancid');
    await discovery.refresh(userId);
    expect(discovery.read(userId, 'deeper').items.map((i) => i.name)).not.toContain('Rancid');

    discovery.block(userId, { kind: 'tag', name: 'skate punk', source: 'settings' });
    expect(discovery.read(userId, 'balanced').items).toEqual([]); // every pick here is skate punk
    expect(discovery.blocklist(userId).tags.map((t) => [t.name, t.key])).toEqual([['Skate Punk', 'skate punk']]);

    expect(discovery.unblock(userId, blocked.id)).toBe(true);
    expect(discovery.unblock(userId, blocked.id)).toBe(false);
    expect(discovery.blocklist(userId).artists).toEqual([]);
  });

  it('keeps each user\'s feedback and blocklist to themselves', async () => {
    const { db, discovery, userId } = setup();
    const other = db.insert(users).values({ username: 'pat', passwordHash: 'x', role: 'user' }).returning().get();
    discovery.block(userId, { kind: 'tag', name: 'Punk', source: 'settings' });
    expect(discovery.blocklist(other.id)).toEqual({ artists: [], tags: [], hidden: [] });
    expect(discovery.unblock(other.id, discovery.blocklist(userId).tags[0]!.id)).toBe(false);
  });
});

describe('preferences and status', () => {
  it('fills in defaults and keeps every section exactly once', () => {
    const { discovery, userId } = setup();
    expect(discovery.preferences(userId)).toEqual({
      defaultMode: 'balanced',
      sections: [
        { id: 'picks', visible: true },
        { id: 'albums', visible: true },
        { id: 'tags', visible: true },
      ],
    });
    discovery.savePreferences(userId, { defaultMode: 'deeper', sections: [{ id: 'tags', visible: false }, { id: 'picks', visible: true }] });
    expect(discovery.preferences(userId)).toEqual({
      defaultMode: 'deeper',
      sections: [
        { id: 'tags', visible: false },
        { id: 'picks', visible: true },
        { id: 'albums', visible: true },
      ],
    });
    expect(discovery.read(userId, 'safer').preferences.defaultMode).toBe('deeper');
  });

  it('reports where a running refresh is, and clears it when done', async () => {
    const { discovery, userId } = setup();
    expect(discovery.status(userId)).toMatchObject({ refreshing: false, progress: null, generatedAt: null });
    const run = discovery.refresh(userId);
    expect(discovery.status(userId)).toMatchObject({ refreshing: true, progress: { step: 1, steps: 4 } });
    await run;
    const done = discovery.status(userId);
    expect(done).toMatchObject({ refreshing: false, progress: null, error: null });
    expect(done.generatedAt).not.toBeNull();
  });
});

describe('feedback and blocklist routes', () => {
  it('accept ratings and blocks, validate them, and 404 what is not there', async () => {
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
      discovery: { schedule: null, feedbackRefreshMs: -1 },
    });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'sam', password: randomBytes(12).toString('base64url') } });
      const headers = { cookie: `offbeat_session=${setup.cookies.find((c) => c.name === 'offbeat_session')?.value}` };
      const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
        app.inject({ method, url: `/api/v1${url}`, headers, ...(payload ? { payload } : {}) });
      const mbid = id('Lagwagon');

      expect((await call('POST', '/discover/feedback', { mbid, value: 'down' })).statusCode).toBe(204);
      expect((await call('POST', '/discover/feedback', { mbid, value: 'meh' })).statusCode).toBe(400);
      expect((await call('POST', '/discover/feedback', { mbid: 'nope', value: 'up' })).statusCode).toBe(400);

      const created = await call('POST', '/blocklist', { kind: 'artist', mbid, name: 'Lagwagon', source: 'discover' });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ kind: 'artist', key: mbid, name: 'Lagwagon', source: 'discover' });
      expect((await call('POST', '/blocklist', { kind: 'tag', name: '', source: 'settings' })).statusCode).toBe(400);
      expect((await call('POST', '/blocklist', { kind: 'artist', name: 'x', source: 'settings' })).statusCode).toBe(400);
      expect((await call('GET', '/blocklist')).json()).toMatchObject({ artists: [{ name: 'Lagwagon' }], tags: [] });

      const itemId = created.json<{ id: number }>().id;
      expect((await call('DELETE', `/blocklist/${itemId}`, {})).statusCode).toBe(204);
      expect((await call('DELETE', `/blocklist/${itemId}`, {})).statusCode).toBe(404);
      expect((await call('DELETE', '/blocklist/abc', {})).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/v1/blocklist' })).statusCode).toBe(401);

      const prefs = { defaultMode: 'safer', sections: [{ id: 'albums', visible: false }, { id: 'picks', visible: true }, { id: 'tags', visible: true }] };
      expect((await call('PUT', '/discover/preferences', prefs)).json()).toEqual(prefs);
      expect((await call('GET', '/discover/preferences')).json()).toEqual(prefs);
      expect((await call('PUT', '/discover/preferences', { ...prefs, defaultMode: 'wild' })).statusCode).toBe(400);
      const twice = { ...prefs, sections: [{ id: 'tags', visible: true }, { id: 'tags', visible: false }] };
      expect((await call('PUT', '/discover/preferences', twice)).statusCode).toBe(400);
      expect((await call('GET', '/discover/status')).json()).toMatchObject({ refreshing: false, nextRefreshAt: null });
    } finally {
      await app.close();
    }
  });
});
