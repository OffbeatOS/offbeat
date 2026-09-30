import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretBox } from '../src/crypto/secret-box.js';
import { openDatabase } from '../src/db/index.js';
import type { LidarrClient, LidarrTrackFile } from '../src/integrations/lidarr/client.js';
import { MusicFileError, MusicFiles, localPathFor } from '../src/library/music-files.js';
import { SettingsStore } from '../src/settings/store.js';

const silentLog = { debug() {}, info() {}, warn() {} } as unknown as FastifyBaseLogger;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A music folder on disk, as Offbeat sees it: NOFX with two tracks, and a file outside it. */
function musicFolder() {
  const base = mkdtempSync(path.join(tmpdir(), 'offbeat-music-'));
  dirs.push(base);
  const music = path.join(base, 'music');
  mkdirSync(path.join(music, 'NOFX', 'Punk in Drublic (1994)'), { recursive: true });
  writeFileSync(path.join(music, 'NOFX', 'Punk in Drublic (1994)', '01 Linoleum.flac'), 'fLaC audio');
  writeFileSync(path.join(music, 'NOFX', 'Punk in Drublic (1994)', '02 Leave It Alone.flac'), 'fLaC audio');
  writeFileSync(path.join(base, 'secret.key'), 'not music');
  return { base, music };
}

const trackFile = (id: number, filePath: string, artistId = 1): LidarrTrackFile => ({ id, artistId, albumId: 10, path: filePath, size: 10 });

function setup(files: LidarrTrackFile[], roots = ['/music']) {
  const settings = new SettingsStore(openDatabase(':memory:'), new SecretBox(randomBytes(32)));
  const lidarr = {
    rootFolders: vi.fn(async () => roots),
    trackFile: vi.fn(async (id: number) => {
      const file = files.find((f) => f.id === id);
      if (!file) throw new Error('404');
      return file;
    }),
    artists: vi.fn(async () => [{ id: 1, artistName: 'NOFX', statistics: { trackFileCount: files.length } }]),
    trackFiles: vi.fn(async () => files),
  } as unknown as LidarrClient;
  return { musicFiles: new MusicFiles(settings, () => lidarr, silentLog), lidarr };
}

describe('localPathFor', () => {
  const folders = [
    { lidarrPath: '/music', offbeatPath: '/mnt/music', mapped: true },
    { lidarrPath: '/music/classical', offbeatPath: '/mnt/classical', mapped: true },
  ];

  it('maps a Lidarr path under the root folder it is in, the most specific first', () => {
    expect(localPathFor('/music/NOFX/Album/01.flac', folders)?.path).toBe(path.resolve('/mnt/music', 'NOFX', 'Album', '01.flac'));
    expect(localPathFor('/music/classical/Bach/01.flac', folders)?.path).toBe(path.resolve('/mnt/classical', 'Bach', '01.flac'));
  });

  it('refuses paths outside every root folder, or that climb out of one', () => {
    expect(localPathFor('/downloads/x.flac', folders)).toBeNull();
    expect(localPathFor('/musicians/x.flac', folders)).toBeNull();
    expect(localPathFor('/music/../etc/passwd', folders)).toBeNull();
    expect(localPathFor('/music/NOFX/../../etc/passwd', folders)).toBeNull();
    expect(localPathFor('/music', folders)).toBeNull();
  });

  it('understands a Lidarr running on Windows', () => {
    const windows = [{ lidarrPath: 'D:\\Music', offbeatPath: '/mnt/music', mapped: true }];
    expect(localPathFor('d:\\music\\NOFX\\01.flac', windows)?.path).toBe(path.resolve('/mnt/music', 'NOFX', '01.flac'));
    expect(localPathFor('D:\\Music\\..\\secret.txt', windows)).toBeNull();
  });
});

describe('MusicFiles', () => {
  it('reads a track file where an admin mapped its root folder', async () => {
    const { music } = musicFolder();
    const { musicFiles } = setup([trackFile(1, '/music/NOFX/Punk in Drublic (1994)/01 Linoleum.flac')]);
    await expect(musicFiles.file(1)).rejects.toThrow(MusicFileError); // /music does not exist here

    const view = await musicFiles.save({ folders: [{ lidarrPath: '/music', offbeatPath: `${music}${path.sep}` }] });
    expect(view.folders).toEqual([{ lidarrPath: '/music', offbeatPath: music, mapped: true }]);
    const file = await musicFiles.file(1);
    expect(path.basename(file.path)).toBe('01 Linoleum.flac');
  });

  it('never serves a file outside the music folder, even through a link inside it', async (context) => {
    const { base, music } = musicFolder();
    try {
      symlinkSync(path.join(base, 'secret.key'), path.join(music, 'NOFX', 'escape.flac'));
    } catch {
      context.skip(); // creating links needs extra rights on Windows
    }
    const { musicFiles } = setup([trackFile(1, '/music/NOFX/escape.flac')]);
    await musicFiles.save({ folders: [{ lidarrPath: '/music', offbeatPath: music }] });
    await expect(musicFiles.file(1)).rejects.toThrow('outside the music folders');
  });

  it('never serves a file whose Lidarr path climbs out of the music folder', async () => {
    const { music } = musicFolder();
    const { musicFiles } = setup([trackFile(2, '/music/../secret.key'), trackFile(3, '/downloads/x.flac')]);
    await musicFiles.save({ folders: [{ lidarrPath: '/music', offbeatPath: music }] });
    await expect(musicFiles.file(2)).rejects.toThrow('outside the music folders');
    await expect(musicFiles.file(3)).rejects.toThrow('outside the music folders');
  });

  it('says plainly when Lidarr has no such file', async () => {
    const { musicFiles } = setup([]);
    await expect(musicFiles.file(99)).rejects.toThrow('Lidarr has no such file');
  });

  it('only maps Lidarr root folders, needs a full path, and forgets a mapping back to the same path', async () => {
    const { music } = musicFolder();
    const { musicFiles } = setup([]);
    await expect(musicFiles.save({ folders: [{ lidarrPath: '/downloads', offbeatPath: music }] })).rejects.toThrow('not one of Lidarr');
    await expect(musicFiles.save({ folders: [{ lidarrPath: '/music', offbeatPath: 'music' }] })).rejects.toThrow('not a full path');
    const same = await musicFiles.save({ folders: [{ lidarrPath: '/music', offbeatPath: '/music/' }] });
    expect(same.folders).toEqual([{ lidarrPath: '/music', offbeatPath: '/music', mapped: false }]);
  });

  it('checks the folders and a sample of files, and remembers the result', async () => {
    const { music } = musicFolder();
    const { musicFiles } = setup([
      trackFile(1, '/music/NOFX/Punk in Drublic (1994)/01 Linoleum.flac'),
      trackFile(2, '/music/NOFX/Punk in Drublic (1994)/02 Leave It Alone.flac'),
      trackFile(3, '/music/NOFX/Punk in Drublic (1994)/03 Missing.flac'),
    ]);

    const unmapped = await musicFiles.check();
    expect(unmapped.ok).toBe(false);
    expect(unmapped.folders[0]).toMatchObject({ lidarrPath: '/music', readable: false, reason: expect.stringContaining('Not found') });

    await musicFiles.save({ folders: [{ lidarrPath: '/music', offbeatPath: music }] });
    const result = await musicFiles.check();
    expect(result.folders[0]).toMatchObject({ readable: true, reason: null });
    expect(result.files).toMatchObject({ checked: 3, readable: 2 });
    expect(result.files.problems).toEqual([
      {
        lidarrPath: '/music/NOFX/Punk in Drublic (1994)/03 Missing.flac',
        offbeatPath: path.join(music, 'NOFX', 'Punk in Drublic (1994)', '03 Missing.flac'),
        reason: expect.stringContaining('Not found'),
      },
    ]);
    expect(result.ok).toBe(false);
    expect((await musicFiles.view()).lastCheck).toEqual(result);
  });
});
