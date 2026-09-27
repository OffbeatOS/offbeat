import type { LidarrOptions, LidarrProfile, LidarrRootFolder } from '@offbeat/shared';
import { z } from 'zod';

/** A Lidarr call that failed, with a message written for the person configuring it. */
export class LidarrError extends Error {}

const DEFAULT_TIMEOUT_MS = 8000;

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

  private async get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    const url = `${this.baseUrl}/api/v1/${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
      });
    } catch (error) {
      throw new LidarrError(this.describeNetworkError(error));
    }

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

    const body: unknown = await response.json().catch(() => undefined);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new LidarrError(
        "That address answered, but not like Lidarr's API. Check the port and any URL base.",
      );
    }
    return parsed.data;
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
