import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A stateful stand-in for Lidarr's catalog API plus MusicBrainz, for add flows. */
export interface FakeCatalog {
  lidarrUrl: string;
  musicbrainzUrl: string;
  apiKey: string;
  /** Artists currently in the fake Lidarr, by Lidarr id. */
  library: Map<number, FakeArtist>;
  /** Every write Lidarr received, in order. */
  writes: { method: string; path: string; body: unknown }[];
  /** Commands Lidarr was asked to run (for example AlbumSearch). */
  commands: { name: string; albumIds?: number[] }[];
  tags: { id: number; label: string }[];
  /** Lidarr's download queue; tests push items in the shape Lidarr returns. */
  queue: Record<string, unknown>[];
  history: Record<string, unknown>[];
  /** Queue removals, with the flags Offbeat sent. */
  removals: { id: number; blocklist: boolean; skipRedownload: boolean }[];
  /** Paths Lidarr received, for counting polls. */
  hits: string[];
  /** While true, queue requests get no answer at all (a stuck Lidarr). */
  stallQueue: boolean;
  /** While true, album lookups fail the way Lidarr does when its metadata service is down. */
  failAlbumLookup: boolean;
  close(): Promise<void>;
}

export interface FakeArtist {
  id: number;
  artistName: string;
  foreignArtistId: string;
  monitored: boolean;
  monitorNewItems: string;
  tags: number[];
  added: string;
  albums: FakeAlbum[];
  /** Albums become visible this long after adding, like Lidarr's refresh. */
  albumsVisibleAt: number;
}

export interface FakeAlbum {
  id: number;
  title: string;
  foreignAlbumId: string;
  albumType: string;
  releaseDate: string;
  monitored: boolean;
  trackFileCount: number;
  trackCount: number;
}

interface CatalogArtist {
  mbid: string;
  name: string;
  albums: { mbid: string; title: string; type: string; date: string }[];
}

/** The world the fake knows about. */
export const WORLD: CatalogArtist[] = [
  {
    mbid: '69158f97-4c07-4c4e-baf8-4e4ab1ed666e',
    name: 'Boards of Canada',
    albums: [
      { mbid: '11111111-0000-4000-8000-000000000001', title: 'Music Has the Right to Children', type: 'Album', date: '1998-04-20' },
      { mbid: '11111111-0000-4000-8000-000000000002', title: 'Geogaddi', type: 'Album', date: '2002-02-18' },
      { mbid: '11111111-0000-4000-8000-000000000003', title: 'In a Beautiful Place Out in the Country', type: 'EP', date: '2000-11-27' },
    ],
  },
  {
    mbid: '22222222-0000-4000-8000-000000000000',
    name: 'Bibio',
    albums: [{ mbid: '22222222-0000-4000-8000-000000000001', title: 'Ambivalence Avenue', type: 'Album', date: '2009-06-22' }],
  },
];

export async function startFakeCatalog(
  options: { albumDelayMs?: number; postAddDelayMs?: number } = {},
): Promise<FakeCatalog> {
  const albumDelayMs = options.albumDelayMs ?? 150;
  // Like Lidarr, post-add actions run after the albums appear and reapply the
  // add's monitor option, undoing any monitoring changed in between.
  const postAddDelayMs = options.postAddDelayMs ?? 200;
  const queue: {
    id: number;
    name: string;
    status: string;
    body: { artistIds?: number[]; albumIds?: number[]; isNewArtist?: boolean };
  }[] = [];
  const downloads: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  const removals: FakeCatalog['removals'] = [];
  const hits: string[] = [];
  const control = { stallQueue: false, failAlbumLookup: false };
  const apiKey = randomBytes(16).toString('hex');
  const library = new Map<number, FakeArtist>();
  const writes: FakeCatalog['writes'] = [];
  const commands: FakeCatalog['commands'] = [];
  const tags: FakeCatalog['tags'] = [];
  let nextArtistId = 1;
  let nextAlbumId = 100;

  const inLibrary = (mbid: string) => [...library.values()].find((a) => a.foreignArtistId === mbid);
  const lookupResource = (artist: CatalogArtist) => {
    const existing = inLibrary(artist.mbid);
    return {
      ...(existing ? { id: existing.id } : {}),
      artistName: artist.name,
      foreignArtistId: artist.mbid,
      disambiguation: '',
      overview: `${artist.name} overview`,
      genres: ['Electronic'],
      images: [{ coverType: 'poster', remoteUrl: `https://images.lidarr.audio/cache/${artist.mbid}.jpg` }],
      metadataOnlyField: 'kept when posting back',
    };
  };
  const artistResource = (a: FakeArtist) => ({
    id: a.id,
    artistName: a.artistName,
    sortName: a.artistName.toLowerCase(),
    foreignArtistId: a.foreignArtistId,
    monitored: a.monitored,
    monitorNewItems: a.monitorNewItems,
    tags: a.tags,
    added: a.added,
    overview: `${a.artistName} overview`,
    images: [],
    statistics: { albumCount: a.albums.length, trackCount: 10, trackFileCount: 0, sizeOnDisk: 0 },
  });
  const owner = (album: FakeAlbum) => [...library.values()].find((a) => a.albums.includes(album));
  const albumResource = (album: FakeAlbum) => ({
    id: album.id,
    title: album.title,
    foreignAlbumId: album.foreignAlbumId,
    albumType: album.albumType,
    secondaryTypes: [],
    releaseDate: album.releaseDate,
    monitored: album.monitored,
    // Like Lidarr: trackCount is 0 unless the artist is monitored; totalTrackCount is real.
    statistics: {
      trackFileCount: album.trackFileCount,
      trackCount: owner(album)?.monitored ? album.trackCount : 0,
      totalTrackCount: album.trackCount,
    },
  });

  const lidarr = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (req.headers['x-api-key'] !== apiKey) return json(res, 401, {});
    const path = url.pathname.replace(/^\/api\/v1\//, '');
    hits.push(path);
    const body = await readBody(req);
    if (req.method !== 'GET') writes.push({ method: req.method ?? '', path, body });

    if (path === 'system/status') return json(res, 200, { appName: 'Lidarr', version: '3.1.0' });
    if (path === 'qualityprofile') return json(res, 200, [{ id: 1, name: 'Any' }]);
    if (path === 'metadataprofile') return json(res, 200, [{ id: 1, name: 'Standard' }]);
    if (path === 'rootfolder') return json(res, 200, [{ path: '/music', freeSpace: 1 }]);
    if (path === 'wanted/missing') return json(res, 200, { totalRecords: 0, records: [] });
    if (path === 'artist' && req.method === 'GET') return json(res, 200, [...library.values()].map(artistResource));

    if (path === 'artist/lookup') {
      const term = url.searchParams.get('term') ?? '';
      const matches = term.startsWith('lidarr:')
        ? WORLD.filter((a) => a.mbid === term.slice(7))
        : WORLD.filter((a) => a.name.toLowerCase().includes(term.toLowerCase()));
      return json(res, 200, matches.map(lookupResource));
    }
    if (path === 'album/lookup') {
      if (control.failAlbumLookup) return json(res, 503, { message: 'metadata unavailable' });
      const term = (url.searchParams.get('term') ?? '').toLowerCase();
      const matches = WORLD.flatMap((a) =>
        a.albums
          .filter((al) => al.title.toLowerCase().includes(term))
          .map((al) => ({
            title: al.title,
            foreignAlbumId: al.mbid,
            albumType: al.type,
            releaseDate: al.date,
            images: [],
            artist: { artistName: a.name, foreignArtistId: a.mbid },
          })),
      );
      return json(res, 200, matches);
    }
    if (path === 'tag' && req.method === 'GET') return json(res, 200, tags);
    if (path === 'tag' && req.method === 'POST') {
      const tag = { id: tags.length + 1, label: (body as { label: string }).label };
      tags.push(tag);
      return json(res, 201, tag);
    }
    if (path === 'artist' && req.method === 'POST') {
      const input = body as Record<string, unknown> & { foreignArtistId: string; addOptions: { monitor: string } };
      if (inLibrary(input.foreignArtistId)) {
        return json(res, 400, [{ propertyName: 'ForeignArtistId', errorMessage: 'This artist has already been added.' }]);
      }
      const known = WORLD.find((a) => a.mbid === input.foreignArtistId)!;
      const artist: FakeArtist = {
        id: nextArtistId++,
        artistName: known.name,
        foreignArtistId: known.mbid,
        monitored: Boolean(input['monitored']),
        monitorNewItems: String(input['monitorNewItems']),
        tags: (input['tags'] as number[]) ?? [],
        added: new Date().toISOString(),
        albumsVisibleAt: Date.now() + albumDelayMs,
        albums: known.albums.map((al) => ({
          id: nextAlbumId++,
          title: al.title,
          foreignAlbumId: al.mbid,
          albumType: al.type,
          releaseDate: al.date,
          monitored: input.addOptions.monitor === 'all',
          trackFileCount: 0,
          trackCount: 10,
        })),
      };
      library.set(artist.id, artist);
      const refresh = { id: queue.length + 1, name: 'RefreshArtist', status: 'started', body: { artistIds: [artist.id], isNewArtist: true } };
      queue.push(refresh);
      const monitorAll = input.addOptions.monitor === 'all';
      setTimeout(() => {
        for (const album of artist.albums) album.monitored = monitorAll;
        // As seen on a real Lidarr: an artist added with no albums to monitor ends up unmonitored.
        if (input.addOptions.monitor === 'none') artist.monitored = false;
        refresh.status = 'completed';
      }, albumDelayMs + postAddDelayMs);
      return json(res, 201, artistResource(artist));
    }
    const artistMatch = path.match(/^artist\/(\d+)$/);
    if (artistMatch) {
      const artist = library.get(Number(artistMatch[1]));
      if (!artist) return json(res, 404, {});
      if (req.method === 'PUT') {
        const update = body as { monitored: boolean; monitorNewItems?: string };
        artist.monitored = Boolean(update.monitored);
        if (update.monitorNewItems !== undefined) artist.monitorNewItems = update.monitorNewItems;
        writes.push({ method: 'PUT', path, body });
      }
      return json(res, req.method === 'PUT' ? 202 : 200, artistResource(artist));
    }
    if (path === 'album' && req.method === 'GET') {
      const artist = library.get(Number(url.searchParams.get('artistId')));
      if (!artist || Date.now() < artist.albumsVisibleAt) return json(res, 200, []);
      return json(res, 200, artist.albums.map(albumResource));
    }
    if (path === 'album/monitor' && req.method === 'PUT') {
      const { albumIds, monitored } = body as { albumIds: number[]; monitored: boolean };
      for (const artist of library.values()) {
        for (const album of artist.albums) if (albumIds.includes(album.id)) album.monitored = monitored;
      }
      return json(res, 202, {});
    }
    if (path === 'command' && req.method === 'GET') return json(res, 200, queue);
    if (path === 'queue') {
      if (control.stallQueue) return; // never answer
      return json(res, 200, { totalRecords: downloads.length, records: downloads });
    }
    if (path === 'history') return json(res, 200, { totalRecords: history.length, records: history });
    const queueMatch = path.match(/^queue\/(\d+)$/);
    if (queueMatch && req.method === 'DELETE') {
      const index = downloads.findIndex((d) => d['id'] === Number(queueMatch[1]));
      if (index < 0) return json(res, 404, {});
      downloads.splice(index, 1);
      removals.push({
        id: Number(queueMatch[1]),
        blocklist: url.searchParams.get('blocklist') === 'true',
        skipRedownload: url.searchParams.get('skipRedownload') === 'true',
      });
      return json(res, 200, {});
    }
    const albumMatch = path.match(/^album\/(\d+)$/);
    if (albumMatch) {
      for (const artist of library.values()) {
        const album = artist.albums.find((a) => a.id === Number(albumMatch[1]));
        if (album) {
          return json(res, 200, {
            id: album.id,
            title: album.title,
            foreignAlbumId: album.foreignAlbumId,
            artist: { artistName: artist.artistName, foreignArtistId: artist.foreignArtistId },
          });
        }
      }
      return json(res, 404, {});
    }
    if (path === 'command' && req.method === 'POST') {
      commands.push(body as { name: string; albumIds?: number[] });
      const posted = body as { name: string; albumIds?: number[] };
      if (posted.name === 'AlbumSearch') {
        queue.push({ id: queue.length + 1, name: 'AlbumSearch', status: 'started', body: { albumIds: posted.albumIds } });
      }
      return json(res, 201, { id: commands.length });
    }
    if (path === 'track') return json(res, 200, [{ id: 1, trackNumber: '1', title: 'Track one', duration: 200000, hasFile: false }]);
    return json(res, 404, {});
  });

  const musicbrainz = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (!req.headers['user-agent']?.startsWith('Offbeat/')) return json(res, 403, {});
    if (url.pathname === '/release-group' && url.searchParams.get('artist')) {
      const artist = WORLD.find((a) => a.mbid === url.searchParams.get('artist'));
      const groups = (artist?.albums ?? []).map((al) => ({
        id: al.mbid,
        title: al.title,
        'primary-type': al.type,
        'secondary-types': [],
        'first-release-date': al.date,
      }));
      return json(res, 200, { 'release-group-count': groups.length, 'release-groups': groups });
    }
    const group = url.pathname.match(/^\/release-group\/(.+)$/);
    if (group) {
      for (const artist of WORLD) {
        const al = artist.albums.find((a) => a.mbid === group[1]);
        if (al) {
          return json(res, 200, {
            id: al.mbid,
            title: al.title,
            'primary-type': al.type,
            'first-release-date': al.date,
            'artist-credit': [{ name: artist.name, artist: { id: artist.mbid, name: artist.name } }],
          });
        }
      }
      return json(res, 404, {});
    }
    if (url.pathname === '/release') {
      return json(res, 200, {
        releases: [{ id: 'r1', date: '1998-04-20', media: [{ position: 1, tracks: [{ number: '1', title: 'Wildlife Analysis', length: 77000 }] }] }],
      });
    }
    return json(res, 404, {});
  });

  const [lidarrPort, mbPort] = await Promise.all([listen(lidarr), listen(musicbrainz)]);
  return {
    lidarrUrl: `http://127.0.0.1:${lidarrPort}`,
    musicbrainzUrl: `http://127.0.0.1:${mbPort}`,
    apiKey,
    library,
    writes,
    commands,
    tags,
    queue: downloads,
    history,
    removals,
    hits,
    get stallQueue() {
      return control.stallQueue;
    },
    set stallQueue(value: boolean) {
      control.stallQueue = value;
    },
    get failAlbumLookup() {
      return control.failAlbumLookup;
    },
    set failAlbumLookup(value: boolean) {
      control.failAlbumLookup = value;
    },
    close: async () => {
      await Promise.all([close(lidarr), close(musicbrainz)]);
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
