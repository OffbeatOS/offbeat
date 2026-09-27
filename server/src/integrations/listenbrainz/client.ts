import Bottleneck from 'bottleneck';
import { z } from 'zod';
import { USER_AGENT } from '../../version.js';
import { fetchBuffered } from '../http.js';

export const LISTENBRAINZ_URL = 'https://api.listenbrainz.org/1';
const TIMEOUT_MS = 10_000;

/** ListenBrainz needs no key; stay well inside its per-IP rate limit. */
const limiter = new Bottleneck({ maxConcurrent: 2, minTime: 250 });

export class ListenBrainzError extends Error {}

const listenCountSchema = z.object({ payload: z.object({ count: z.number() }) });

export interface ListenBrainzClientOptions {
  url?: string;
  timeoutMs?: number;
}

export class ListenBrainzClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor({ url = LISTENBRAINZ_URL, timeoutMs = TIMEOUT_MS }: ListenBrainzClientOptions = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  /** How many listens the user has, or null when ListenBrainz has no such user. */
  async listenCount(username: string): Promise<number | null> {
    const response = await this.get(`user/${encodeURIComponent(username)}/listen-count`);
    if (response.status === 404) return null;
    if (!response.ok) throw new ListenBrainzError(`ListenBrainz returned an error (HTTP ${response.status}). Try again shortly.`);
    const parsed = listenCountSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new ListenBrainzError('ListenBrainz answered in an unexpected format. Try again shortly.');
    return parsed.data.payload.count;
  }

  private async get(path: string): Promise<Response> {
    try {
      return await limiter.schedule(() =>
        fetchBuffered(`${this.url}/${path}`, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          timeoutMs: this.timeoutMs,
        }),
      );
    } catch {
      throw new ListenBrainzError('Could not reach ListenBrainz. Check that Offbeat can reach the internet.');
    }
  }
}
