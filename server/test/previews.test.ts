import type { ArtistPreview, CreatedUser } from '@offbeat/shared';
import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { DeezerClient } from '../src/integrations/deezer/client.js';
import type { MusicBrainzClient } from '../src/integrations/musicbrainz/client.js';
import { ImageUrls } from '../src/library/image-urls.js';
import { Previews, isDeezerPreviewUrl, titleKey } from '../src/previews/previews.js';
import { tmpImageDir } from './helpers.js';

const silentLog = { debug() {}, info() {}, warn() {} } as unknown as FastifyBaseLogger;
const PENNYWISE = '06b8c50e-1dbc-45fb-8c63-52e8e1b04bd8';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Deezer, where the search ranks "Penny Wise" (a different act) above Pennywise, like the real one. */
async function fakeDeezer() {
  const requests: string[] = [];
  const url = await serve((req, res) => {
    requests.push(req.url ?? '');
    const json = (body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    if (path === '/search/artist' && new URL(req.url ?? '/', 'http://fake').searchParams.get('q') === 'BLANKEY JET CITY') {
      return json({ data: [{ id: 4, name: 'Blankey Jet City' }] });
    }
    // No playable top tracks where Offbeat runs (regional licensing), but albums with previews.
    if (path === '/artist/4/albums') {
      return json({
        data: [
          { id: 41, title: 'Complete Single Collection', record_type: 'compile' },
          { id: 42, title: 'Bang!', record_type: 'album', cover_big: 'https://cdn-images.dzcdn.net/images/cover/bang/500x500.jpg' },
          { id: 43, title: 'Skunk', record_type: 'album' },
        ],
      });
    }
    if (path === '/artist/4/top') return json({ data: [{ id: 400, title: 'Region locked', preview: '' }] });
    if (path === '/album/42/tracks') return json({ data: [{ id: 421, title: 'Rain Dog', preview: 'https://cdnt-preview.dzcdn.net/api/1/1/b.mp3' }] });
    if (path === '/album/43/tracks') return json({ data: [{ id: 431, title: 'Silent', preview: '' }, { id: 432, title: 'Skunk', preview: 'https://cdnt-preview.dzcdn.net/api/1/1/c.mp3' }] });
    if (path === '/album/41/tracks') return json({ data: [{ id: 411, title: 'Single', preview: 'https://cdnt-preview.dzcdn.net/api/1/1/d.mp3' }] });
    if (path === '/search/artist') return json({ data: [{ id: 1, name: 'Penny Wise' }, { id: 2, name: 'Pennywise' }, { id: 3, name: 'Pennywise' }] });
    if (path === '/artist/1/albums') return json({ data: [{ id: 10, title: 'Pennywise' }] });
    if (path === '/artist/2/albums') return json({ data: [{ id: 20, title: 'Some Other Band Album' }] });
    if (path === '/artist/3/albums') return json({ data: [{ id: 30, title: 'Full Circle (Remastered)' }] });
    if (path === '/artist/3/top') {
      return json({
        data: [
          { id: 301, title: 'Bro Hymn', preview: 'https://cdnt-preview.dzcdn.net/api/1/1/a.mp3?hdnea=x', album: { title: 'Full Circle', cover_big: 'https://cdn-images.dzcdn.net/images/cover/abc/500x500.jpg' } },
          { id: 302, title: 'No preview here', preview: '', album: { title: 'Full Circle' } },
        ],
      });
    }
    if (path === '/track/301') return json({ id: 301, title: 'Bro Hymn', preview: 'https://cdnt-preview.dzcdn.net/api/1/1/a.mp3?hdnea=x' });
    if (path === '/track/666') return json({ id: 666, title: 'Sneaky', preview: 'https://evil.example.com/a.mp3' });
    return json({ error: { type: 'DataException', message: 'no data', code: 800 } });
  });
  return { url, requests };
}

const musicbrainz = {
  releaseGroups: vi.fn(async (_mbid: string, options?: { albumsOnly?: boolean }) =>
    options?.albumsOnly ? [{ id: 'rg1', title: 'Full Circle' }, { id: 'rg2', title: 'Unknown Road' }, { id: 'rg3', title: 'BANG!' }] : [],
  ),
} as unknown as MusicBrainzClient;

describe('titleKey and preview addresses', () => {
  it('compares album titles without edition notes or punctuation', () => {
    expect(titleKey('Full Circle (Remastered)')).toBe(titleKey('Full Circle'));
    expect(titleKey('...And Out Come the Wolves - Deluxe Edition')).toBe(titleKey('And Out Come the Wolves'));
  });

  it("only accepts Deezer's preview servers, over https", () => {
    expect(isDeezerPreviewUrl('https://cdnt-preview.dzcdn.net/api/a.mp3')).toBe(true);
    expect(isDeezerPreviewUrl('http://cdnt-preview.dzcdn.net/api/a.mp3')).toBe(false);
    expect(isDeezerPreviewUrl('https://dzcdn.net.evil.example.com/a.mp3')).toBe(false);
    expect(isDeezerPreviewUrl('https://user@cdnt-preview.dzcdn.net/a.mp3')).toBe(false);
    expect(isDeezerPreviewUrl('https://169.254.169.254/latest')).toBe(false);
  });
});

describe('Previews', () => {
  async function setup() {
    const deezer = await fakeDeezer();
    const previews = new Previews(openDatabase(':memory:'), new DeezerClient(deezer.url), musicbrainz, new ImageUrls(randomBytes(32)), silentLog);
    return { previews, deezer };
  }

  it('matches the artist by exact name and a shared album, not the first search result', async () => {
    const { previews } = await setup();
    const preview = await previews.forArtist(PENNYWISE, 'Pennywise');
    expect(preview).toMatchObject({ artistName: 'Pennywise', deezerUrl: 'https://www.deezer.com/artist/3' });
    expect(preview!.tracks).toEqual([
      { deezerTrackId: 301, title: 'Bro Hymn', albumTitle: 'Full Circle', coverUrl: expect.stringContaining('api/v1/images/remote'), durationMs: 30_000, audioUrl: 'api/v1/previews/301/audio' },
    ]);
  });

  it('takes previews from the albums, albums first, when the top tracks have none', async () => {
    const { previews } = await setup();
    const preview = await previews.forArtist('00000000-0000-4000-8000-00000000b1c0', 'BLANKEY JET CITY');
    expect(preview?.tracks.map((t) => [t.title, t.albumTitle])).toEqual([
      ['Rain Dog', 'Bang!'],
      ['Skunk', 'Skunk'],
      ['Single', 'Complete Single Collection'],
    ]);
    expect(preview!.tracks[0]!.coverUrl).toContain('api/v1/images/remote');
    expect(vi.mocked(musicbrainz.releaseGroups)).toHaveBeenLastCalledWith('00000000-0000-4000-8000-00000000b1c0', { albumsOnly: true, firstPageOnly: true });
  });

  it('has no preview when no same-name artist shares an album, and remembers that', async () => {
    const { previews, deezer } = await setup();
    vi.mocked(musicbrainz.releaseGroups).mockResolvedValueOnce([{ id: 'x', title: 'Nothing Alike' }] as never);
    expect(await previews.forArtist(PENNYWISE, 'Pennywise')).toBeNull();
    const searches = deezer.requests.filter((r) => r.startsWith('/search')).length;
    expect(await previews.forArtist(PENNYWISE, 'Pennywise')).toBeNull();
    expect(deezer.requests.filter((r) => r.startsWith('/search')).length).toBe(searches);
    expect(await previews.forArtist('00000000-0000-4000-8000-000000000001', 'Nobody Called This')).toBeNull();
  });

  it('gives a fresh preview address from Deezer, and refuses one anywhere else', async () => {
    const { previews } = await setup();
    expect(await previews.audioUrl(301)).toMatch(/^https:\/\/cdnt-preview\.dzcdn\.net\//);
    await expect(previews.audioUrl(666)).rejects.toThrow('no preview');
  });
});

describe('preview routes', () => {
  async function setup() {
    const deezer = await fakeDeezer();
    const app = await buildApp({
      config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
      db: openDatabase(':memory:'),
      secretKey: randomBytes(32),
      imageCacheDir: tmpImageDir(),
      webRoot: null,
      logger: false,
      activity: { autoStart: false },
      discovery: { schedule: null },
      sources: { deezerUrl: deezer.url },
    });
    servers.push({ close: (cb: () => void) => void app.close().then(cb) } as unknown as Server);
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'boss', password: randomBytes(12).toString('base64url') } });
    const admin = `offbeat_session=${res.cookies.find((c) => c.name === 'offbeat_session')!.value}`;
    const get = (cookie: string, url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie, ...headers } });
    return { app, admin, get };
  }

  it('needs the Stream permission, and says when there is no preview', async () => {
    const { app, admin, get } = await setup();
    vi.spyOn(app.previews, 'forArtist').mockResolvedValue(null);
    expect((await get(admin, `/artists/${PENNYWISE}/preview?name=Pennywise`)).statusCode).toBe(404);
    expect((await get(admin, `/artists/${PENNYWISE}/preview`)).statusCode).toBe(400);

    const created = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie: admin }, payload: { username: 'sam', role: 'user', permissions: [] } });
    const { temporaryPassword } = created.json<CreatedUser>();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'sam', password: temporaryPassword } });
    const sam = `offbeat_session=${login.cookies.find((c) => c.name === 'offbeat_session')!.value}`;
    const pw = randomBytes(12).toString('base64url');
    await app.inject({ method: 'PUT', url: '/api/v1/account/password', headers: { cookie: sam }, payload: { currentPassword: temporaryPassword, newPassword: pw } });
    expect((await get(sam, `/artists/${PENNYWISE}/preview?name=Pennywise`)).statusCode).toBe(403);
    expect((await get(sam, '/previews/301/audio')).statusCode).toBe(403);
  });

  it('answers with the previews it found', async () => {
    const { app, admin, get } = await setup();
    const preview: ArtistPreview = { artistMbid: PENNYWISE, artistName: 'Pennywise', deezerUrl: 'https://www.deezer.com/artist/3', tracks: [] };
    const forArtist = vi.spyOn(app.previews, 'forArtist').mockResolvedValue(preview);
    expect((await get(admin, `/artists/${PENNYWISE.toUpperCase()}/preview?name=Pennywise`)).json()).toEqual(preview);
    expect(forArtist).toHaveBeenCalledWith(PENNYWISE, 'Pennywise');
  });

  it('passes preview audio through, with the range the browser asks for', async () => {
    const { app, admin, get } = await setup();
    const audio = Buffer.from('ID3 fake mp3 bytes for a preview');
    let range: string | undefined;
    const upstream = await serve((req, res) => {
      range = req.headers.range;
      if (range === 'bytes=4-7') {
        res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes 4-7/${audio.length}`, 'Content-Length': '4', 'Accept-Ranges': 'bytes' }).end(audio.subarray(4, 8));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length), 'Accept-Ranges': 'bytes' }).end(audio);
    });
    vi.spyOn(app.previews, 'audioUrl').mockResolvedValue(`${upstream}/a.mp3`);

    const whole = await get(admin, '/previews/301/audio');
    expect(whole.statusCode).toBe(200);
    expect(whole.headers).toMatchObject({ 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'accept-ranges': 'bytes' });
    expect(whole.rawPayload.equals(audio)).toBe(true);

    const part = await get(admin, '/previews/301/audio', { range: 'bytes=4-7' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 4-7/${audio.length}`);
    expect(part.body).toBe('fake');
    expect(range).toBe('bytes=4-7');
  });

  it('refuses what is not audio', async () => {
    const { app, admin, get } = await setup();
    const upstream = await serve((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>'));
    vi.spyOn(app.previews, 'audioUrl').mockResolvedValue(`${upstream}/a.mp3`);
    expect((await get(admin, '/previews/301/audio')).statusCode).toBe(502);
  });
});
