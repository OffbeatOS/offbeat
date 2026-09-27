import type { FastifyBaseLogger } from 'fastify';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LidarrClient } from '../integrations/lidarr/client.js';
import { imageVersion } from './library.js';

/** Raster formats only: SVG can carry script and is never served from Offbeat's origin. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
const TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]));
const MAX_BYTES = 10 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 8000;

export interface Artwork {
  body: Buffer;
  contentType: string;
}

interface ArtworkSource {
  lidarrId: number;
  imagePath: string | null;
  imageRemoteUrl: string | null;
}

/**
 * Artist artwork, fetched server side so Lidarr's API key never reaches the
 * browser, and cached under `config/cache/images` keyed by artwork version.
 */
export class ArtworkCache {
  private readonly inFlight = new Map<string, Promise<Artwork | null>>();

  constructor(
    private readonly dir: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async artist(source: ArtworkSource, client: () => LidarrClient | null): Promise<Artwork | null> {
    const version = imageVersion(source);
    if (!version) return null;
    const name = `artist-${source.lidarrId}-${version}`;

    const cached = await this.read(name);
    if (cached) return cached;

    let pending = this.inFlight.get(name);
    if (!pending) {
      pending = this.fetchAndStore(name, source, client).finally(() => this.inFlight.delete(name));
      this.inFlight.set(name, pending);
    }
    return pending;
  }

  private async fetchAndStore(
    name: string,
    source: ArtworkSource,
    client: () => LidarrClient | null,
  ): Promise<Artwork | null> {
    const artwork = await this.fetch(source, client);
    if (!artwork) return null;
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${name}.${EXTENSIONS[artwork.contentType]}`);
    // Write then rename, so a crash never leaves a half-written image behind.
    await writeFile(`${file}.tmp`, artwork.body);
    await rename(`${file}.tmp`, file);
    await this.removeOlderVersions(source.lidarrId, name);
    return artwork;
  }

  private async fetch(source: ArtworkSource, client: () => LidarrClient | null): Promise<Artwork | null> {
    const lidarr = client();
    if (source.imagePath && lidarr) {
      // Lidarr serves resized posters as poster-250.jpg; fall back to the original.
      const sized = source.imagePath.replace(/\/(poster|fanart)(\.\w+)(\?|$)/, (_m, type: string, ext: string, q: string) =>
        `/${type}-${type === 'poster' ? 250 : 360}${ext}${q}`,
      );
      for (const candidate of new Set([sized, source.imagePath])) {
        const image = await lidarr.mediaCover(candidate);
        if (image && accept(image)) return image;
      }
    }
    if (source.imageRemoteUrl) return this.fetchRemote(source.imageRemoteUrl);
    return null;
  }

  /** Public artwork hosts need no credentials; nothing secret is sent. */
  private async fetchRemote(url: string): Promise<Artwork | null> {
    if (!/^https:\/\//i.test(url)) return null;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
      if (!response.ok) return null;
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      const image = { body: Buffer.from(await response.arrayBuffer()), contentType };
      return accept(image) ? image : null;
    } catch (error) {
      this.log.debug({ err: error, url }, 'Remote artwork fetch failed');
      return null;
    }
  }

  private async read(name: string): Promise<Artwork | null> {
    for (const [ext, contentType] of Object.entries(TYPES)) {
      try {
        return { body: await readFile(path.join(this.dir, `${name}.${ext}`)), contentType };
      } catch {
        // not cached in this format
      }
    }
    return null;
  }

  private async removeOlderVersions(lidarrId: number, keep: string) {
    const prefix = `artist-${lidarrId}-`;
    const files = await readdir(this.dir).catch(() => [] as string[]);
    await Promise.all(
      files
        .filter((file) => file.startsWith(prefix) && !file.startsWith(keep))
        .map((file) => unlink(path.join(this.dir, file)).catch(() => undefined)),
    );
  }
}

function accept(image: Artwork): boolean {
  image.contentType = image.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return image.contentType in EXTENSIONS && image.body.length > 0 && image.body.length <= MAX_BYTES;
}
