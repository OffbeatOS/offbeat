import { type CreatedUser, DEFAULT_MEMBER_PERMISSIONS } from '@offbeat/shared';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRange } from '../src/api/stream.js';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { MusicFileError } from '../src/library/music-files.js';
import { Transcoder, TranscoderUnavailable } from '../src/streaming/transcoder.js';
import { tmpImageDir } from './helpers.js';

const password = () => randomBytes(12).toString('base64url');
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A stand-in audio file: 1000 bytes, each byte its position modulo 256, so ranges are easy to check. */
function audioFile(name = 'track.flac') {
  const dir = mkdtempSync(path.join(tmpdir(), 'offbeat-stream-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  return file;
}

async function setup(filePath: string) {
  const db = openDatabase(':memory:');
  const app = await buildApp({
    config: { baseUrl: '', trustProxy: false, logLevel: 'error' },
    db,
    secretKey: randomBytes(32),
    imageCacheDir: tmpImageDir(),
    webRoot: null,
    logger: false,
    activity: { autoStart: false },
    discovery: { schedule: null },
  });
  cleanup.push(() => app.close());
  const files = vi.spyOn(app.musicFiles, 'file').mockImplementation(async (id: number) => {
    if (id !== 7) throw new MusicFileError('Lidarr has no such file. It may have been upgraded or removed.');
    return { trackFileId: 7, path: filePath, size: 1000, file: { id: 7, path: `/music/NOFX/${path.basename(filePath)}` } };
  });
  const setupRes = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'boss', password: password() } });
  const admin = cookieOf(setupRes);
  const get = (cookie: string | null, url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const member = async (username: string, permissions: string[]) => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie: admin }, payload: { username, role: 'user', permissions } });
    const { temporaryPassword } = created.json<CreatedUser>();
    const cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: temporaryPassword } }));
    const pw = password();
    await app.inject({ method: 'PUT', url: '/api/v1/account/password', headers: { cookie }, payload: { currentPassword: temporaryPassword, newPassword: pw } });
    return cookie;
  };
  return { app, db, admin, get, member, files };
}

function cookieOf(res: { cookies: { name: string; value: string }[] }) {
  const cookie = res.cookies.find((c) => c.name === 'offbeat_session');
  if (!cookie) throw new Error('no session cookie');
  return `offbeat_session=${cookie.value}`;
}

describe('parseRange', () => {
  it.each([
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=900-', { start: 900, end: 999 }],
    ['bytes=990-5000', { start: 990, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }],
  ])('%s', (header, expected) => {
    expect(parseRange(header, 1000)).toEqual(expected);
  });

  it('refuses ranges past the end, and ignores ones it does not understand', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=500-100', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
});

describe('GET /stream/:trackFileId', () => {
  it('needs a signed-in user with the Stream permission', async () => {
    const { get, member, admin } = await setup(audioFile());
    expect((await get(null, '/stream/7')).statusCode).toBe(401);
    const listener = await member('robin', ['stream']);
    const other = await member('sam', ['add-albums']);
    expect((await get(listener, '/stream/7')).statusCode).toBe(200);
    expect((await get(admin, '/stream/7')).statusCode).toBe(200);
    const refused = await get(other, '/stream/7');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toBe('Your account cannot play music. Ask an admin.');
  });

  it('is on by default for new Members (the Add User form and auto-created accounts)', () => {
    expect(DEFAULT_MEMBER_PERMISSIONS).toContain('stream');
  });

  it('sends the whole file, or the byte range the browser asks for', async () => {
    const { get, admin } = await setup(audioFile());
    const whole = await get(admin, '/stream/7');
    expect(whole.headers).toMatchObject({ 'accept-ranges': 'bytes', 'content-type': 'audio/flac', 'content-length': '1000' });
    expect(whole.rawPayload.length).toBe(1000);

    const part = await get(admin, '/stream/7', { range: 'bytes=300-303' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 300-303/1000');
    expect([...part.rawPayload]).toEqual([44, 45, 46, 47]);

    const tail = await get(admin, '/stream/7', { range: 'bytes=-2' });
    expect([...tail.rawPayload]).toEqual([998 % 256, 999 % 256]);

    const past = await get(admin, '/stream/7', { range: 'bytes=5000-' });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe('bytes */1000');
  });

  it('only streams track files Offbeat can find, never a path', async () => {
    const { get, admin, files } = await setup(audioFile());
    expect((await get(admin, '/stream/8')).statusCode).toBe(404);
    expect((await get(admin, '/stream/..%2F..%2Fsecret.key')).statusCode).toBe(400);
    expect((await get(admin, '/stream/-1')).statusCode).toBe(400);
    expect(files.mock.calls.map(([id]) => id)).toEqual([8]);
  });

  it('transcodes to MP3 from the second asked for, and stops ffmpeg when the listener leaves', async () => {
    const { app, get, admin } = await setup(audioFile('track.ape'));
    const start = vi.spyOn(app.transcoder, 'start').mockImplementation(async (_file, seconds) => {
      // A stand-in for ffmpeg that just says where it started.
      const child = spawn(process.execPath, ['-e', `process.stdout.write('mp3 from ${seconds}')`], { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve) => child.once('spawn', resolve));
      return child;
    });
    const res = await get(admin, '/stream/7?transcode=mp3&t=42.5');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['accept-ranges']).toBeUndefined();
    expect(res.body).toBe('mp3 from 42.5');
    expect(start.mock.calls[0]![1]).toBe(42.5);
    expect((await get(admin, '/stream/7?transcode=wav')).statusCode).toBe(400);
  });

  it('says plainly when ffmpeg is missing', async () => {
    const { app, get, admin } = await setup(audioFile('track.ape'));
    vi.spyOn(app.transcoder, 'start').mockRejectedValue(new TranscoderUnavailable('ffmpeg could not start: spawn ffmpeg ENOENT'));
    const res = await get(admin, '/stream/7?transcode=mp3');
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toContain('needs ffmpeg');
  });
});

describe('the stream permission migration', () => {
  it('turns Stream on for existing Members once, and leaves admins alone', () => {
    const db = openDatabase(':memory:');
    db.insert(users)
      .values([
        { username: 'robin', passwordHash: 'x', role: 'user', permissions: '["add-albums"]' },
        { username: 'sam', passwordHash: 'x', role: 'user', permissions: '["stream"]' },
        { username: 'boss', passwordHash: 'x', role: 'admin', permissions: '[]' },
      ])
      .run();
    const sql = readFileSync(path.join(import.meta.dirname, '../drizzle/0010_stream_permission.sql'), 'utf8');
    db.$client.exec(sql);
    db.$client.exec(sql);
    const rows = db.select({ username: users.username, permissions: users.permissions }).from(users).all();
    expect(Object.fromEntries(rows.map((r) => [r.username, JSON.parse(r.permissions)]))).toEqual({
      robin: ['add-albums', 'stream'],
      sam: ['stream'],
      boss: [],
    });
  });
});

/** A real ffmpeg, when this machine has one (CI and the Docker image do; a bare checkout may not). */
function findFfmpeg(): string | null {
  const candidate = process.env.FFMPEG_PATH ?? 'ffmpeg';
  try {
    execFileSync(candidate, ['-version'], { stdio: 'ignore' });
    return candidate;
  } catch {
    return null;
  }
}

describe('Transcoder with a real ffmpeg', () => {
  const ffmpeg = findFfmpeg();

  it.skipIf(!ffmpeg)('turns a WAV into MP3, starting where asked', async () => {
    // One second of a 440 Hz tone, 8 kHz mono 16-bit.
    const rate = 8000;
    const samples = Buffer.alloc(rate * 2);
    for (let i = 0; i < rate; i++) samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + samples.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(samples.length, 40);
    const file = audioFile('tone.wav');
    writeFileSync(file, Buffer.concat([header, samples]));

    const transcoder = new Transcoder(ffmpeg!, { warn() {} } as never);
    expect(await transcoder.version()).toMatch(/\S/);
    const child = await transcoder.start(file, 0.5);
    const chunks: Buffer[] = [];
    for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
    const mp3 = Buffer.concat(chunks);
    // An MP3 frame (or an ID3 tag) at the start, and about half a second of audio.
    expect(mp3.subarray(0, 3).toString() === 'ID3' || (mp3[0] === 0xff && (mp3[1]! & 0xe0) === 0xe0)).toBe(true);
    expect(mp3.length).toBeGreaterThan(1000);
  });

  it('reports no version when ffmpeg is missing', async () => {
    const transcoder = new Transcoder(path.join(tmpdir(), 'no-such-ffmpeg'), { warn() {} } as never);
    expect(await transcoder.version()).toBeNull();
    await expect(transcoder.start('x.flac', 0)).rejects.toThrow(TranscoderUnavailable);
  });
});
