import type { AddResult, AlbumDetail, ArtistDetail, LibraryResponse, SearchResponse } from '@offbeat/shared';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { requests } from '../src/db/schema.js';
import { type FakeCatalog, WORLD, startFakeCatalog } from './fake-catalog.js';
import { tmpImageDir } from './helpers.js';

const BOC = WORLD[0]!;
const GEOGADDI = BOC.albums[1]!;
const fakes: FakeCatalog[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

async function setup(
  addSettings: {
    addMonitored?: boolean;
    addMonitorAlbums?: 'latest' | 'all' | 'future';
    searchOnAdd?: boolean;
    addTag?: string | null;
  } = {},
) {
  const fake = await startFakeCatalog();
  fakes.push(fake);
  const db = openDatabase(':memory:');
  const app = await buildApp({
    config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
    db,
    secretKey: randomBytes(32),
    imageCacheDir: tmpImageDir(),
    webRoot: null,
    logger: false,
    upstreamTimeoutMs: 2000,
    musicbrainz: { url: fake.musicbrainzUrl, minTimeMs: 0 },
    catalog: { pollMs: 50, albumAppearTimeoutMs: 3000 },
  });
  const setupRes = await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'admin', password: randomBytes(12).toString('base64url') },
  });
  const cookie = `offbeat_session=${setupRes.cookies.find((c) => c.name === 'offbeat_session')?.value}`;
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
  await call('POST', '/setup/lidarr', {
    url: fake.lidarrUrl,
    apiKey: fake.apiKey,
    qualityProfileId: 1,
    metadataProfileId: 1,
    rootFolderPath: '/music',
    ...addSettings,
  });
  await app.library.sync();
  return { app, db, fake, call };
}

/** The test rules used against real Lidarr: no search, unmonitored, tagged. */
const safe = { addMonitored: false, searchOnAdd: false, addTag: 'offbeat-test' };

/** POSTs an album add (answered at once with 202) and waits for its add-result event. */
async function addAlbum(
  app: Awaited<ReturnType<typeof setup>>['app'],
  call: Awaited<ReturnType<typeof setup>>['call'],
  mbid: string,
  artistMbid: string,
): Promise<AddResult> {
  const result = new Promise<AddResult>((resolve) => {
    const off = app.activity.subscribe((event) => {
      if (event.type === 'add-result' && event.data.albumMbid === mbid) {
        off();
        resolve(event.data);
      }
    });
  });
  const res = await call('POST', `/albums/${mbid}`, { artistMbid });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ status: { kind: 'adding' } });
  return result;
}

describe('search', () => {
  it('ranks an exact artist match first and lists its albums from MusicBrainz', async () => {
    const { call } = await setup();
    const res = (await call('GET', '/search?q=boards%20of%20canada')).json<SearchResponse>();
    expect(res.top).toMatchObject({ kind: 'artist', artist: { name: 'Boards of Canada', inLibrary: false } });
    // Albums only (the EP is on the Artist page), newest first.
    expect(res.albums.map((a) => a.title)).toEqual(['Geogaddi', 'Music Has the Right to Children']);
    expect(res.albums.every((a) => a.status.kind === 'available')).toBe(true);
    expect(res.albums[0]?.coverUrl).toMatch(/^api\/v1\/images\/album\/[0-9a-f-]{36}$/);
  });

  it('puts an album first when the query is an album title', async () => {
    const { call } = await setup();
    const res = (await call('GET', '/search?q=geogaddi')).json<SearchResponse>();
    expect(res.top).toMatchObject({ kind: 'album', album: { title: 'Geogaddi', artistName: 'Boards of Canada' } });
  });

  it('validates the query', async () => {
    const { call } = await setup();
    expect((await call('GET', '/search?q=a')).statusCode).toBe(400);
  });

  it("still finds artists while Lidarr's album lookup is down", async () => {
    const { call, fake } = await setup();
    fake.failAlbumLookup = true;
    const res = await call('GET', '/search?q=boards%20of%20canada');
    expect(res.statusCode).toBe(200);
    expect(res.json<SearchResponse>().top).toMatchObject({ kind: 'artist', artist: { name: 'Boards of Canada' } });
  });
});

describe('adding an artist', () => {
  it('uses the saved defaults, tags it, and updates the library cache immediately', async () => {
    const { call, fake, db } = await setup(safe);
    const res = await call('POST', `/artists/${BOC.mbid}`, {});
    expect(res.statusCode).toBe(200);
    const detail = res.json<ArtistDetail>();
    expect(detail).toMatchObject({ inLibrary: true, monitored: false });

    const post = fake.writes.find((w) => w.method === 'POST' && w.path === 'artist')!.body as Record<string, unknown>;
    expect(post).toMatchObject({
      foreignArtistId: BOC.mbid,
      monitored: false,
      monitorNewItems: 'none',
      qualityProfileId: 1,
      rootFolderPath: '/music',
      addOptions: { monitor: 'none', searchForMissingAlbums: false },
      tags: [fake.tags.find((t) => t.label === 'offbeat-test')!.id],
      metadataOnlyField: 'kept when posting back',
    });
    expect(fake.commands).toEqual([]);

    // No sync needed: Library already has it.
    const library = (await call('GET', '/library')).json<LibraryResponse>();
    expect(library.artists.map((a) => a.mbid)).toContain(BOC.mbid);
    expect(db.select().from(requests).all()).toHaveLength(1);
  });

  it('never creates duplicates, even with overlapping clicks', async () => {
    const { call, fake } = await setup(safe);
    const results = await Promise.all([1, 2, 3].map(() => call('POST', `/artists/${BOC.mbid}`, {})));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(fake.library.size).toBe(1);

    // And adding again later is a no-op, not a Lidarr error.
    const again = await call('POST', `/artists/${BOC.mbid}`, {});
    expect(again.statusCode).toBe(200);
    expect(fake.writes.filter((w) => w.method === 'POST' && w.path === 'artist')).toHaveLength(1);
  });

  it('with default settings, monitors the latest album and future releases, searches, and tags offbeat', async () => {
    const { call, fake } = await setup();
    await call('POST', `/artists/${BOC.mbid}`, {});
    const post = fake.writes.find((w) => w.path === 'artist')!.body as Record<string, unknown>;
    expect(post).toMatchObject({
      monitored: true,
      monitorNewItems: 'all',
      addOptions: { monitor: 'latest', searchForMissingAlbums: true },
      tags: [fake.tags.find((t) => t.label === 'offbeat')!.id],
    });
  });

  it('can monitor the whole discography instead', async () => {
    const { call, fake } = await setup({ addMonitorAlbums: 'all' });
    await call('POST', `/artists/${BOC.mbid}`, {});
    const post = fake.writes.find((w) => w.path === 'artist')!.body as Record<string, unknown>;
    expect(post).toMatchObject({ monitored: true, monitorNewItems: 'all', addOptions: { monitor: 'all' } });
  });
});

describe('adding a single album', () => {
  it('with default settings, monitors the artist but only this album, with no future releases', async () => {
    const { app, call, fake } = await setup();
    const result = await addAlbum(app, call, GEOGADDI.mbid, BOC.mbid);
    expect(result).toMatchObject({ ok: true });
    const post = fake.writes.find((w) => w.path === 'artist')!.body as Record<string, unknown>;
    expect(post).toMatchObject({ monitored: true, monitorNewItems: 'none', addOptions: { monitor: 'none', searchForMissingAlbums: false } });
    expect(fake.commands.filter((c) => c.name === 'AlbumSearch')).toHaveLength(1);
  });

  it('adds the artist with nothing monitored, then monitors only that album', async () => {
    const { app, call, fake } = await setup(safe);
    const result = await addAlbum(app, call, GEOGADDI.mbid, BOC.mbid);
    expect(result).toMatchObject({ ok: true, status: { kind: 'requested' } });
    const detail = (await call('GET', `/albums/${GEOGADDI.mbid}`)).json<AlbumDetail>();
    expect(detail).toMatchObject({ title: 'Geogaddi', status: { kind: 'requested' }, artistInLibrary: true });

    const artist = [...fake.library.values()][0]!;
    expect(artist.monitored).toBe(false);
    expect(artist.albums.filter((a) => a.monitored).map((a) => a.title)).toEqual(['Geogaddi']);
    expect(fake.commands).toEqual([]); // searchOnAdd is off
  });

  it('searches for the album when searching on add is on', async () => {
    const { app, call, fake } = await setup({ ...safe, searchOnAdd: true });
    await addAlbum(app, call, GEOGADDI.mbid, BOC.mbid);
    const albumId = [...fake.library.values()][0]!.albums.find((a) => a.title === 'Geogaddi')!.id;
    expect(fake.commands).toEqual([{ name: 'AlbumSearch', albumIds: [albumId] }]);
  });

  it('shows the new status in search results right away', async () => {
    const { app, call } = await setup(safe);
    await addAlbum(app, call, GEOGADDI.mbid, BOC.mbid);
    const res = (await call('GET', '/search?q=boards%20of%20canada')).json<SearchResponse>();
    expect(res.top).toMatchObject({ kind: 'artist', artist: { inLibrary: true } });
    const statuses = Object.fromEntries(res.albums.map((a) => [a.title, a.status.kind]));
    expect(statuses).toEqual({ Geogaddi: 'requested', 'Music Has the Right to Children': 'available' });
  });
});

describe('artist and album pages', () => {
  it('works by MBID before and after adding', async () => {
    const { call } = await setup(safe);
    const before = (await call('GET', `/artists/${BOC.mbid}`)).json<ArtistDetail>();
    expect(before).toMatchObject({ name: 'Boards of Canada', inLibrary: false, monitored: null });
    expect(before.releases.map((r) => r.type).sort()).toEqual(['Album', 'Album', 'EP']);

    await call('POST', `/artists/${BOC.mbid}`, {});
    await new Promise((r) => setTimeout(r, 200)); // let the fake finish loading albums
    const after = (await call('GET', `/artists/${BOC.mbid}`)).json<ArtistDetail>();
    expect(after).toMatchObject({ inLibrary: true, monitored: false });
    expect(after.releases.every((r) => r.status.kind === 'available')).toBe(true);
  });

  it('toggles monitoring for library artists only', async () => {
    const { call } = await setup(safe);
    expect((await call('PATCH', `/artists/${BOC.mbid}`, { monitored: true })).statusCode).toBe(404);
    await call('POST', `/artists/${BOC.mbid}`, {});
    const res = (await call('PATCH', `/artists/${BOC.mbid}`, { monitored: true })).json<ArtistDetail>();
    expect(res.monitored).toBe(true);
  });

  it('shows an album page from MusicBrainz for artists not in Lidarr', async () => {
    const { call } = await setup();
    const res = (await call('GET', `/albums/${BOC.albums[0]!.mbid}`)).json<AlbumDetail>();
    expect(res).toMatchObject({
      title: 'Music Has the Right to Children',
      artistName: 'Boards of Canada',
      artistInLibrary: false,
      tracks: [{ position: '1', title: 'Wildlife Analysis', durationMs: 77000, hasFile: null }],
    });
  });

  it.each(['not-an-id', '12345', '69158f97-4c07-4c4e-baf8'])('rejects MBID %j', async (id) => {
    const { call } = await setup();
    expect((await call('GET', `/artists/${id}`)).statusCode).toBe(400);
  });

  it('404s an unknown artist', async () => {
    const { call } = await setup();
    expect((await call('GET', '/artists/00000000-0000-4000-8000-000000000999')).statusCode).toBe(404);
  });
});

describe('album page actions', () => {
  it('reports monitoring and track counts, with more releases by the artist', async () => {
    const { app, call } = await setup(safe);
    await addAlbum(app, call, GEOGADDI.mbid, BOC.mbid);
    const album = (await call('GET', `/albums/${GEOGADDI.mbid}`)).json<AlbumDetail>();
    expect(album).toMatchObject({ monitored: true, trackFileCount: 0, trackCount: 10, status: { kind: 'requested' } });
    expect(album.more.map((r) => r.title)).not.toContain('Geogaddi');
    expect(album.more.length).toBeGreaterThan(0);
  });

  it('toggles album monitoring and searches, only for albums in Lidarr', async () => {
    const { app, call, fake } = await setup(safe);
    const other = BOC.albums[0]!.mbid;
    expect((await call('PATCH', `/albums/${other}`, { monitored: true })).statusCode).toBe(404);
    expect((await call('POST', `/albums/${other}/search`, {})).statusCode).toBe(404);

    await addAlbum(app, call, GEOGADDI.mbid, BOC.mbid);
    const off = (await call('PATCH', `/albums/${GEOGADDI.mbid}`, { monitored: false })).json<AlbumDetail>();
    expect(off).toMatchObject({ monitored: false, status: { kind: 'available' } });

    expect((await call('POST', `/albums/${GEOGADDI.mbid}/search`, {})).statusCode).toBe(202);
    const albumId = [...fake.library.values()][0]!.albums.find((a) => a.title === 'Geogaddi')!.id;
    expect(fake.commands).toEqual([{ name: 'AlbumSearch', albumIds: [albumId] }]);
  });

  it('has no Lidarr fields for albums outside Lidarr', async () => {
    const { call } = await setup();
    const album = (await call('GET', `/albums/${GEOGADDI.mbid}`)).json<AlbumDetail>();
    expect(album).toMatchObject({ monitored: null, trackFileCount: null, trackCount: null, artistInLibrary: false });
    expect(album.tracks.every((t) => t.hasFile === null)).toBe(true);
  });
});
