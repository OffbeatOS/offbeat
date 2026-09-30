import Bottleneck from 'bottleneck';
import { z } from 'zod';
import { USER_AGENT } from '../../version.js';
import { fetchBuffered } from '../http.js';

export const DEEZER_URL = 'https://api.deezer.com';
const TIMEOUT_MS = 10_000;
/** Deezer allows 50 requests per 5 seconds; stay well inside it. */
const limiter = new Bottleneck({ maxConcurrent: 4, minTime: 150 });

export class DeezerError extends Error {}

const artistSchema = z.object({ id: z.number(), name: z.string() });
const albumSchema = z.object({
  id: z.number(),
  title: z.string(),
  record_type: z.string().nullish(),
  cover_medium: z.string().nullish(),
  cover_big: z.string().nullish(),
});
export type DeezerAlbum = z.infer<typeof albumSchema>;
const trackSchema = z.object({
  id: z.number(),
  title: z.string(),
  duration: z.number().nullish(),
  preview: z.string().nullish(),
  artist: z.object({ id: z.number(), name: z.string() }).nullish(),
  album: z.object({ title: z.string(), cover_medium: z.string().nullish(), cover_big: z.string().nullish() }).nullish(),
});
export type DeezerTrack = z.infer<typeof trackSchema>;
const listOf = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item).default([]) });

/**
 * Deezer's public API (no key): artist search, an artist's albums and top
 * tracks, and a track's 30-second preview address, for previews of artists
 * not in the library. Preview addresses expire after minutes, so they are
 * asked for when played, never stored.
 */
export class DeezerClient {
  constructor(
    private readonly url = DEEZER_URL,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  searchArtists(name: string): Promise<z.infer<typeof artistSchema>[]> {
    return this.list(`search/artist?q=${encodeURIComponent(name)}&limit=10`, artistSchema);
  }

  albums(artistId: number): Promise<z.infer<typeof albumSchema>[]> {
    return this.list(`artist/${artistId}/albums?limit=100`, albumSchema);
  }

  topTracks(artistId: number, limit = 5): Promise<DeezerTrack[]> {
    return this.list(`artist/${artistId}/top?limit=${limit}`, trackSchema);
  }

  /** An album's tracks. They carry no album, so callers add it. */
  albumTracks(albumId: number, limit = 10): Promise<DeezerTrack[]> {
    return this.list(`album/${albumId}/tracks?limit=${limit}`, trackSchema);
  }

  track(id: number): Promise<DeezerTrack> {
    return this.get(`track/${id}`, trackSchema);
  }

  private async list<T extends z.ZodType>(path: string, item: T): Promise<z.infer<T>[]> {
    return (await this.get(path, listOf(item))).data;
  }

  private async get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await limiter.schedule(() =>
        fetchBuffered(`${this.url}/${path}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeoutMs: this.timeoutMs }),
      );
    } catch {
      throw new DeezerError('Could not reach Deezer. Check that Offbeat can reach the internet.');
    }
    if (!response.ok) throw new DeezerError(`Deezer answered with an error (HTTP ${response.status})`);
    const body: unknown = await response.json().catch(() => undefined);
    // Deezer reports errors (unknown ids, quota) as 200 with an "error" object.
    if (body && typeof body === 'object' && 'error' in body) throw new DeezerError('Deezer has no such item, or is busy. Try again shortly.');
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new DeezerError('Deezer answered in an unexpected format');
    return parsed.data;
  }
}
