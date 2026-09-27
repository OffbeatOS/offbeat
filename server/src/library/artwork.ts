import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LidarrClient } from '../integrations/lidarr/client.js';
import { imageVersion } from './library.js';
import { fetchAllowedImage } from './remote-image.js';

/** Raster formats only: SVG can carry script and is never served from Offbeat's origin. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CACHE_BYTES = 512 * 1024 * 1024;

export interface Artwork {
  body: Buffer;
  contentType: string;
}

interface ArtworkSource {
  lidarrId: number;
  imagePath: string | null;
  imageRemoteUrl: string | null;
}

interface Entry {
  file: string;
  size: number;
  lastUsed: number;
}

/**
 * Artwork fetched server side, so Lidarr's API key never reaches the browser,
 * and cached under `config/cache/images`. The cache is capped: when it grows
 * past `maxBytes` the least recently used images are evicted. Last use is
 * recorded as the file's modified time, so the order survives restarts.
 */
export class ArtworkCache {
  private readonly inFlight = new Map<string, Promise<Artwork | null>>();
  private index: Map<string, Entry> | null = null;
  private total = 0;

  constructor(
    private readonly dir: string,
    private readonly log: FastifyBaseLogger,
    private readonly maxBytes = DEFAULT_CACHE_BYTES,
  ) {}

  /** Artwork for a library artist, from Lidarr's MediaCover (or a public fallback). */
  artist(source: ArtworkSource, client: () => LidarrClient | null): Promise<Artwork | null> {
    const version = imageVersion(source);
    if (!version) return Promise.resolve(null);
    return this.get(`artist-${source.lidarrId}-${version}`, async () => {
      const artwork = await this.fromLidarr(source, client);
      if (artwork) await this.removeByPrefix(`artist-${source.lidarrId}-`, `artist-${source.lidarrId}-${version}`);
      return artwork;
    });
  }

  /** Artwork from an allowlisted public host. The caller must have verified the URL's signature. */
  remote(url: string): Promise<Artwork | null> {
    const name = `remote-${createHash('sha256').update(url).digest('hex').slice(0, 32)}`;
    return this.get(name, () => this.fetchRemote(url));
  }

  /** Drops every cached image for an artist that left Lidarr. */
  async removeArtist(lidarrId: number) {
    await this.removeByPrefix(`artist-${lidarrId}-`);
  }

  /** Current cache size in bytes, for tests and diagnostics. */
  async size(): Promise<number> {
    await this.loadIndex();
    return this.total;
  }

  private async get(name: string, produce: () => Promise<Artwork | null>): Promise<Artwork | null> {
    const cached = await this.read(name);
    if (cached) return cached;

    let pending = this.inFlight.get(name);
    if (!pending) {
      pending = produce()
        .then(async (artwork) => {
          if (artwork) await this.store(name, artwork);
          return artwork;
        })
        .finally(() => this.inFlight.delete(name));
      this.inFlight.set(name, pending);
    }
    return pending;
  }

  private async fromLidarr(source: ArtworkSource, client: () => LidarrClient | null): Promise<Artwork | null> {
    const lidarr = client();
    if (source.imagePath && lidarr) {
      // Lidarr serves resized posters as poster-250.jpg; fall back to the original.
      const sized = source.imagePath.replace(
        /\/(poster|fanart)(\.\w+)(\?|$)/,
        (_m, type: string, ext: string, q: string) => `/${type}-${type === 'poster' ? 250 : 360}${ext}${q}`,
      );
      for (const candidate of new Set([sized, source.imagePath])) {
        const image = await lidarr.mediaCover(candidate);
        if (image && accept(image)) return image;
      }
    }
    return source.imageRemoteUrl ? this.fetchRemote(source.imageRemoteUrl) : null;
  }

  private async fetchRemote(url: string): Promise<Artwork | null> {
    try {
      const image = await fetchAllowedImage(url, { maxBytes: MAX_IMAGE_BYTES });
      return image && accept(image) ? image : null;
    } catch (error) {
      this.log.debug({ err: error, url }, 'Remote artwork fetch failed');
      return null;
    }
  }

  private async read(name: string): Promise<Artwork | null> {
    const index = await this.loadIndex();
    const entry = index.get(name);
    if (!entry) return null;
    try {
      const body = await readFile(path.join(this.dir, entry.file));
      this.touch(entry);
      const ext = entry.file.slice(entry.file.lastIndexOf('.') + 1);
      const contentType = Object.entries(EXTENSIONS).find(([, e]) => e === ext)?.[0] ?? 'image/jpeg';
      return { body, contentType };
    } catch {
      this.forget(name);
      return null;
    }
  }

  private async store(name: string, artwork: Artwork) {
    const index = await this.loadIndex();
    await mkdir(this.dir, { recursive: true });
    const file = `${name}.${EXTENSIONS[artwork.contentType]}`;
    const full = path.join(this.dir, file);
    // Write then rename, so a crash never leaves a half-written image behind.
    await writeFile(`${full}.tmp`, artwork.body);
    await rename(`${full}.tmp`, full);
    this.forget(name);
    index.set(name, { file, size: artwork.body.length, lastUsed: Date.now() });
    this.total += artwork.body.length;
    await this.evict();
  }

  private async evict() {
    if (this.total <= this.maxBytes || !this.index) return;
    const oldestFirst = [...this.index.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [name, entry] of oldestFirst) {
      if (this.total <= this.maxBytes) break;
      this.forget(name);
      await unlink(path.join(this.dir, entry.file)).catch(() => undefined);
    }
    this.log.debug({ bytes: this.total }, 'Artwork cache trimmed');
  }

  private async removeByPrefix(prefix: string, keep?: string) {
    const index = await this.loadIndex();
    for (const [name, entry] of [...index.entries()]) {
      if (name.startsWith(prefix) && name !== keep) {
        this.forget(name);
        await unlink(path.join(this.dir, entry.file)).catch(() => undefined);
      }
    }
  }

  private touch(entry: Entry) {
    entry.lastUsed = Date.now();
    const now = new Date(entry.lastUsed);
    utimes(path.join(this.dir, entry.file), now, now).catch(() => undefined);
  }

  private forget(name: string) {
    const entry = this.index?.get(name);
    if (entry) {
      this.total -= entry.size;
      this.index?.delete(name);
    }
  }

  /** Builds the in-memory index from disk once, clearing leftovers from interrupted writes. */
  private async loadIndex(): Promise<Map<string, Entry>> {
    if (this.index) return this.index;
    const index = new Map<string, Entry>();
    let total = 0;
    const files = await readdir(this.dir).catch(() => [] as string[]);
    for (const file of files) {
      const full = path.join(this.dir, file);
      if (file.endsWith('.tmp')) {
        await unlink(full).catch(() => undefined);
        continue;
      }
      const dot = file.lastIndexOf('.');
      if (dot <= 0) continue;
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) continue;
      index.set(file.slice(0, dot), { file, size: info.size, lastUsed: info.mtimeMs });
      total += info.size;
    }
    // Another call may have finished first; keep whichever index exists.
    if (!this.index) {
      this.index = index;
      this.total = total;
      await this.evict();
    }
    return this.index;
  }
}

function accept(image: Artwork): boolean {
  image.contentType = image.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return image.contentType in EXTENSIONS && image.body.length > 0 && image.body.length <= MAX_IMAGE_BYTES;
}
