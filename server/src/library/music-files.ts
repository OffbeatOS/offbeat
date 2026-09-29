import type { MusicFileProblem, MusicFilesCheck, MusicFilesInput, MusicFilesView, MusicFolder } from '@offbeat/shared';
import { open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { LidarrClient, LidarrTrackFile } from '../integrations/lidarr/client.js';
import type { SettingsStore } from '../settings/store.js';

const KEY = 'music-files';
const CHECK_KEY = 'music-files-check';
/** Lidarr's root folders rarely change; its files change with every import. */
const ROOTS_FOR_MS = 5 * 60_000;
const FILE_FOR_MS = 10 * 60_000;
const MAX_CACHED_FILES = 10_000;
/** The health check reads the start of this many files, spread across the library. */
const SAMPLE_ARTISTS = 8;
const SAMPLE_PER_ARTIST = 3;
const MAX_PROBLEMS = 5;

const storedSchema = z.object({
  folders: z.array(z.object({ lidarrPath: z.string(), offbeatPath: z.string() })).default([]),
});

/** A Lidarr track file Offbeat can read: its real local path, checked to be inside a music folder. */
export interface LocalTrackFile {
  trackFileId: number;
  path: string;
  size: number | null;
  file: LidarrTrackFile;
}

/** A file Offbeat cannot serve. `reason` is written for the person who has to fix it. */
export class MusicFileError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 502 = 404,
  ) {
    super(message);
  }
}

/**
 * Reading audio from the music folders Lidarr manages. Lidarr is the index:
 * its track files say where each file is, in Lidarr's own paths, and each of
 * its root folders is read at the same path or wherever an admin maps it.
 * Only a track file id ever picks a file, never a path from a request, and
 * the file's real path must stay inside its mapped root folder.
 */
export class MusicFiles {
  private roots: { at: number; paths: string[] } | null = null;
  private readonly files = new Map<number, { at: number; file: LidarrTrackFile }>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly lidarr: () => LidarrClient | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  async view(): Promise<MusicFilesView> {
    return { folders: this.foldersFor(await this.rootFolders()), lastCheck: this.lastCheck() };
  }

  /** Saves where each root folder is read. Only Lidarr's current root folders can be mapped. */
  async save(input: MusicFilesInput): Promise<MusicFilesView> {
    const roots = await this.rootFolders({ fresh: true });
    const folders: { lidarrPath: string; offbeatPath: string }[] = [];
    for (const { lidarrPath, offbeatPath } of input.folders) {
      if (!roots.includes(lidarrPath)) throw new MusicFileError(`${lidarrPath} is not one of Lidarr's root folders`, 409);
      const local = trimSlashes(offbeatPath.trim());
      if (!local || local === lidarrPath) continue;
      if (!path.isAbsolute(local)) throw new MusicFileError(`${offbeatPath} is not a full path. Start it with / (or a drive or share on Windows).`, 409);
      folders.push({ lidarrPath, offbeatPath: local });
    }
    this.settings.set(KEY, { folders }, { encrypted: false });
    return this.view();
  }

  /**
   * The local file for a Lidarr track file id. Throws MusicFileError when
   * Lidarr has no such file, it is outside every root folder, or Offbeat
   * cannot see it.
   */
  async file(trackFileId: number): Promise<LocalTrackFile> {
    const file = await this.trackFile(trackFileId);
    const folders = this.foldersFor(await this.rootFolders());
    const local = localPathFor(file.path, folders);
    if (!local) throw new MusicFileError('That file is outside the music folders Offbeat reads');
    let real: string;
    let root: string;
    try {
      [real, root] = await Promise.all([realpath(local.path), realpath(local.folder.offbeatPath)]);
    } catch (error) {
      throw new MusicFileError(reasonFor(error));
    }
    // A link inside the music folder must not lead out of it.
    if (!isInside(real, root)) throw new MusicFileError('That file is outside the music folders Offbeat reads');
    return { trackFileId, path: real, size: file.size ?? null, file };
  }

  /** Can Offbeat read each root folder, and the start of a sample of files across the library? */
  async check(): Promise<MusicFilesCheck> {
    const lidarr = this.requireLidarr();
    const folders = this.foldersFor(await this.rootFolders({ fresh: true }));
    const folderResults = await Promise.all(
      folders.map(async (folder) => {
        try {
          const dir = await opendir(folder.offbeatPath);
          await dir.close();
          return { lidarrPath: folder.lidarrPath, offbeatPath: folder.offbeatPath, readable: true, reason: null };
        } catch (error) {
          return { lidarrPath: folder.lidarrPath, offbeatPath: folder.offbeatPath, readable: false, reason: reasonFor(error) };
        }
      }),
    );

    const sample = await this.sampleFiles(lidarr);
    const problems: MusicFileProblem[] = [];
    let readable = 0;
    for (const file of sample) {
      this.remember(file);
      const local = localPathFor(file.path, folders);
      if (!local) {
        problems.push({ lidarrPath: file.path, offbeatPath: null, reason: 'Outside every root folder Lidarr lists' });
        continue;
      }
      try {
        const handle = await open(local.path, 'r');
        try {
          await handle.read(Buffer.alloc(16), 0, 16, 0);
        } finally {
          await handle.close();
        }
        readable++;
      } catch (error) {
        problems.push({ lidarrPath: file.path, offbeatPath: local.path, reason: reasonFor(error) });
      }
    }

    const result: MusicFilesCheck = {
      at: new Date().toISOString(),
      ok: folderResults.every((f) => f.readable) && problems.length === 0,
      folders: folderResults,
      files: { checked: sample.length, readable, problems: problems.slice(0, MAX_PROBLEMS) },
    };
    this.settings.set(CHECK_KEY, result, { encrypted: false });
    if (!result.ok) this.log.warn({ folders: folderResults, problems: result.files.problems }, 'Music files are not all readable');
    return result;
  }

  private lastCheck(): MusicFilesCheck | null {
    return (this.settings.get(CHECK_KEY, z.custom<MusicFilesCheck>()) as MusicFilesCheck | null) ?? null;
  }

  private foldersFor(roots: string[]): MusicFolder[] {
    const saved = new Map((this.settings.get(KEY, storedSchema)?.folders ?? []).map((f) => [f.lidarrPath, f.offbeatPath]));
    return roots.map((lidarrPath) => {
      const offbeatPath = saved.get(lidarrPath);
      return offbeatPath ? { lidarrPath, offbeatPath, mapped: true } : { lidarrPath, offbeatPath: lidarrPath, mapped: false };
    });
  }

  private async rootFolders({ fresh = false } = {}): Promise<string[]> {
    if (!fresh && this.roots && Date.now() - this.roots.at < ROOTS_FOR_MS) return this.roots.paths;
    const paths = await this.requireLidarr().rootFolders();
    this.roots = { at: Date.now(), paths };
    return paths;
  }

  private async trackFile(id: number): Promise<LidarrTrackFile> {
    const cached = this.files.get(id);
    if (cached && Date.now() - cached.at < FILE_FOR_MS) return cached.file;
    try {
      const file = await this.requireLidarr().trackFile(id);
      this.remember(file);
      return file;
    } catch (error) {
      this.log.debug({ err: error, trackFileId: id }, 'Lidarr track file lookup failed');
      throw new MusicFileError('Lidarr has no such file. It may have been upgraded or removed.');
    }
  }

  private remember(file: LidarrTrackFile) {
    if (this.files.size >= MAX_CACHED_FILES) this.files.delete(this.files.keys().next().value!);
    this.files.set(file.id, { at: Date.now(), file });
  }

  /** A few files from each of several artists, spread across the library (the same ones each time). */
  private async sampleFiles(lidarr: LidarrClient): Promise<LidarrTrackFile[]> {
    const artists = (await lidarr.artists()).filter((a) => (a.statistics?.trackFileCount ?? 0) > 0);
    const picked = spread(artists, SAMPLE_ARTISTS);
    const files = await Promise.all(picked.map((a) => lidarr.trackFiles({ artistId: a.id }).catch(() => [])));
    return files.flatMap((list) => spread(list, SAMPLE_PER_ARTIST));
  }

  private requireLidarr(): LidarrClient {
    const lidarr = this.lidarr();
    if (!lidarr) throw new MusicFileError('Connect Lidarr first', 409);
    return lidarr;
  }
}

/**
 * Offbeat's path for a file Lidarr names: find the root folder it is in (in
 * Lidarr's paths), then the same relative path under where Offbeat reads that
 * folder. Null when the file is outside every root folder or its path tries
 * to climb out of one.
 */
export function localPathFor(lidarrFile: string, folders: MusicFolder[]): { path: string; folder: MusicFolder } | null {
  let best: { folder: MusicFolder; parts: string[] } | null = null;
  for (const folder of folders) {
    const parts = relativeParts(lidarrFile, folder.lidarrPath);
    if (parts && (!best || folder.lidarrPath.length > best.folder.lidarrPath.length)) best = { folder, parts };
  }
  if (!best) return null;
  const root = path.resolve(best.folder.offbeatPath);
  const local = path.resolve(root, ...best.parts);
  return isInside(local, root) ? { path: local, folder: best.folder } : null;
}

/** The path segments of `file` below `root`, in Lidarr's path style, or null if it is not below it. */
function relativeParts(file: string, root: string): string[] | null {
  // Lidarr in Docker uses POSIX paths; Lidarr on Windows uses drive letters or shares.
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(root);
  const style = windows ? path.win32 : path.posix;
  const norm = (p: string) => (windows ? style.normalize(p).toLowerCase() : style.normalize(p));
  const base = trimSlashes(norm(root));
  const target = norm(file);
  const separator = windows ? '\\' : '/';
  if (!target.startsWith(base + separator)) return null;
  const parts = file
    .slice(style.normalize(root).replace(/[\\/]+$/, '').length + 1)
    .split(windows ? /[\\/]/ : '/')
    .filter((p) => p !== '');
  if (!parts.length || parts.some((p) => p === '..' || p === '.')) return null;
  return parts;
}

function isInside(child: string, root: string): boolean {
  const a = path.resolve(child);
  const b = path.resolve(root);
  const same = process.platform === 'win32' ? (x: string, y: string) => x.toLowerCase() === y.toLowerCase() : (x: string, y: string) => x === y;
  if (same(a, b)) return false;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return process.platform === 'win32' ? a.toLowerCase().startsWith(prefix.toLowerCase()) : a.startsWith(prefix);
}

function trimSlashes(p: string): string {
  // Keep a bare root ("/" or "C:\") intact.
  const trimmed = p.replace(/[\\/]+$/, '');
  return trimmed === '' || /^[a-z]:$/i.test(trimmed) ? p : trimmed;
}

/** Up to `count` items evenly spaced through the list, so a check sees more than the first artists. */
function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]!);
}

function reasonFor(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'Not found. Check that the music folder is mounted, and where Offbeat reads it.';
  if (code === 'EACCES' || code === 'EPERM') return 'Offbeat is not allowed to read it. Check the folder permissions for PUID and PGID.';
  if (code === 'ENOTDIR') return 'Part of the path is a file, not a folder';
  return error instanceof Error ? error.message : 'Could not read it';
}
