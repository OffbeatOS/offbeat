import type { LidarrOptions, LidarrProfile, LidarrRootFolder } from '@offbeat/shared';
import Bottleneck from 'bottleneck';
import { z } from 'zod';

/** A Lidarr call that failed, with a message written for the person configuring it. */
export class LidarrError extends Error {}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * One limiter per Lidarr instance, shared by every client for it, so a burst
 * of artwork requests or a sync cannot flood Lidarr.
 */
const limiters = new Map<string, Bottleneck>();
function limiterFor(baseUrl: string) {
  let limiter = limiters.get(baseUrl);
  if (!limiter) {
    limiter = new Bottleneck({ maxConcurrent: 6, minTime: 10 });
    limiters.set(baseUrl, limiter);
  }
  return limiter;
}

/**
 * Accepts what people paste: trailing slashes, a URL base such as `/lidarr`,
 * or even a copied `/api/v1` suffix. Returns `http(s)://host[:port][/base]`.
 */
export function normalizeLidarrUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LidarrError('Enter a full address, for example http://lidarr:8686');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LidarrError('The address must start with http:// or https://');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api(\/v1)?$/i, '');
  return `${url.origin}${path}`;
}

const statusSchema = z.object({ appName: z.string(), version: z.string() });
const profileSchema = z.object({ id: z.number(), name: z.string() });
const imageSchema = z.object({
  coverType: z.string(),
  url: z.string().nullish(),
  remoteUrl: z.string().nullish(),
});

const artistSchema = z.object({
  id: z.number(),
  artistName: z.string(),
  sortName: z.string().nullish(),
  foreignArtistId: z.string(),
  monitored: z.boolean(),
  added: z.string(),
  genres: z.array(z.string()).nullish(),
  images: z.array(imageSchema).nullish(),
  statistics: z
    .object({
      albumCount: z.number().nullish(),
      trackCount: z.number().nullish(),
      trackFileCount: z.number().nullish(),
      sizeOnDisk: z.number().nullish(),
    })
    .nullish(),
});
export type LidarrArtist = z.infer<typeof artistSchema>;

const missingPageSchema = z.object({
  totalRecords: z.number(),
  records: z.array(z.object({ artistId: z.number() })),
});

const rootFolderSchema = z.object({
  path: z.string(),
  freeSpace: z.number().nullish(),
  defaultQualityProfileId: z.number().nullish(),
  defaultMetadataProfileId: z.number().nullish(),
});

export interface LidarrClientOptions {
  url: string;
  apiKey: string;
  timeoutMs?: number;
}

export class LidarrClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor({ url, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }: LidarrClientOptions) {
    this.baseUrl = normalizeLidarrUrl(url);
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  /** Checks the address and key, and loads what the default dropdowns need. */
  async loadOptions(): Promise<LidarrOptions> {
    const status = await this.get('system/status', statusSchema);
    if (status.appName.toLowerCase() !== 'lidarr') {
      throw new LidarrError(`That address is ${status.appName}, not Lidarr`);
    }
    const [qualityProfiles, metadataProfiles, rootFolders] = await Promise.all([
      this.get('qualityprofile', z.array(profileSchema)),
      this.get('metadataprofile', z.array(profileSchema)),
      this.get('rootfolder', z.array(rootFolderSchema)),
    ]);
    const byName = (a: LidarrProfile, b: LidarrProfile) => a.name.localeCompare(b.name);
    return {
      version: status.version,
      qualityProfiles: qualityProfiles.map(({ id, name }) => ({ id, name })).sort(byName),
      metadataProfiles: metadataProfiles.map(({ id, name }) => ({ id, name })).sort(byName),
      rootFolders: rootFolders.map(
        (folder): LidarrRootFolder => ({
          path: folder.path,
          freeSpace: folder.freeSpace ?? null,
          defaultQualityProfileId: folder.defaultQualityProfileId ?? null,
          defaultMetadataProfileId: folder.defaultMetadataProfileId ?? null,
        }),
      ),
    };
  }

  /** Every artist in Lidarr. */
  artists(): Promise<LidarrArtist[]> {
    return this.get('artist', z.array(artistSchema));
  }

  /** Monitored albums with no files, counted per Lidarr artist id. */
  async missingAlbumCounts(): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    const pageSize = 1000;
    for (let page = 1; page <= 200; page++) {
      const result = await this.get(
        `wanted/missing?page=${page}&pageSize=${pageSize}&monitored=true&includeArtist=false`,
        missingPageSchema,
      );
      for (const { artistId } of result.records) counts.set(artistId, (counts.get(artistId) ?? 0) + 1);
      if (page * pageSize >= result.totalRecords || result.records.length === 0) break;
    }
    return counts;
  }

  /**
   * Fetches artwork from Lidarr's MediaCover endpoint, which needs the API key.
   * Only paths under this Lidarr's own `/MediaCover/` are allowed, so a
   * malformed artist record can never make Offbeat send the key elsewhere.
   * Returns null when Lidarr has no such image.
   */
  async mediaCover(path: string): Promise<{ body: Buffer; contentType: string } | null> {
    const base = new URL(this.baseUrl);
    const target = new URL(path, base.origin);
    const allowedPrefix = `${base.pathname.replace(/\/$/, '')}/MediaCover/`;
    if (target.origin !== base.origin || !target.pathname.startsWith(allowedPrefix)) {
      throw new LidarrError('Refusing to fetch artwork outside Lidarr');
    }
    const response = await this.send(target.toString(), 'image/*');
    if (response.status === 404) return null;
    this.assertOk(response);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;
    return { body: Buffer.from(await response.arrayBuffer()), contentType };
  }

  private async send(url: string, accept: string): Promise<Response> {
    try {
      return await limiterFor(this.baseUrl).schedule(() =>
        fetch(url, {
          headers: { 'X-Api-Key': this.apiKey, Accept: accept },
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'manual',
        }),
      );
    } catch (error) {
      throw new LidarrError(this.describeNetworkError(error));
    }
  }

  private async get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    const response = await this.send(`${this.baseUrl}/api/v1/${path}`, 'application/json');
    this.assertOk(response);

    const body: unknown = await response.json().catch(() => undefined);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new LidarrError(
        "That address answered, but not like Lidarr's API. Check the port and any URL base.",
      );
    }
    return parsed.data;
  }

  private assertOk(response: Response) {
    if (response.status === 401 || response.status === 403) {
      throw new LidarrError('Lidarr rejected the API key. Copy it again from Settings, General in Lidarr.');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new LidarrError(
        'Lidarr redirected the request. If it uses a URL base, include it in the address (for example http://lidarr:8686/lidarr).',
      );
    }
    if (response.status === 404) {
      throw new LidarrError(
        'No Lidarr API at that address. If Lidarr uses a URL base, include it (for example http://lidarr:8686/lidarr).',
      );
    }
    if (!response.ok) {
      throw new LidarrError(`Lidarr returned an error (HTTP ${response.status}). Check its logs.`);
    }
  }

  private describeNetworkError(error: unknown): string {
    const where = new URL(this.baseUrl).host;
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return `Lidarr did not respond within ${Math.round(this.timeoutMs / 1000)} seconds at ${where}. Check the address, and that Offbeat can reach that network.`;
    }
    const code = (error as { cause?: { code?: string } } | null)?.cause?.code;
    switch (code) {
      case 'ECONNREFUSED':
        return `Nothing is listening at ${where}. Check the port, and that Lidarr is running.`;
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return `Could not find the host ${new URL(this.baseUrl).hostname}. From Docker, use the container name or an IP address.`;
      case 'EHOSTUNREACH':
      case 'ENETUNREACH':
      case 'ETIMEDOUT':
        return `Could not reach ${where} from Offbeat's network.`;
      case 'ECONNRESET':
      case 'EPROTO':
      case 'ERR_SSL_WRONG_VERSION_NUMBER':
        return `The connection to ${where} failed. Check whether Lidarr uses http or https.`;
      default:
        return `Could not connect to ${where}.`;
    }
  }
}
