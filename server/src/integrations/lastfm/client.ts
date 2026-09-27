import Bottleneck from 'bottleneck';
import { z } from 'zod';
import { USER_AGENT } from '../../version.js';
import { fetchBuffered } from '../http.js';

export const LASTFM_URL = 'https://ws.audioscrobbler.com/2.0/';
const TIMEOUT_MS = 10_000;

/** Last.fm's documented limit is about five requests per second per key. */
const limiters = new Map<string, Bottleneck>();
function limiterFor(apiKey: string) {
  let limiter = limiters.get(apiKey);
  if (!limiter) {
    limiter = new Bottleneck({ maxConcurrent: 2, minTime: 220 });
    limiters.set(apiKey, limiter);
  }
  return limiter;
}

/** Last.fm answered with an error, or could not be reached. `code` is Last.fm's error number when it gave one. */
export class LastfmError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
  }
}

/** Last.fm error numbers worth telling apart. */
const INVALID_KEY = new Set([10, 26]);
const NOT_FOUND = 6;
const RATE_LIMITED = 29;

const errorSchema = z.object({ error: z.number(), message: z.string().optional() });
const userSchema = z.object({ user: z.object({ name: z.string(), playcount: z.coerce.number().optional() }) });
// Last.fm sends a single object instead of a one-item list, and numbers as strings.
const oneOrMany = <T extends z.ZodType>(item: T) => z.union([z.array(item), item.transform((x) => [x])]);
const similarSchema = z.object({
  similarartists: z.object({
    artist: oneOrMany(z.object({ name: z.string(), mbid: z.string().optional(), match: z.coerce.number() })).optional(),
  }),
});
const topArtistsSchema = z.object({
  topartists: z.object({
    artist: oneOrMany(z.object({ name: z.string(), mbid: z.string().optional(), playcount: z.coerce.number() })).optional(),
  }),
});

/** An artist Last.fm considers similar, with its match from 0 to 1. Last.fm leaves out the MBID for some. */
export interface LastfmSimilar {
  mbid: string | null;
  name: string;
  match: number;
}

export interface LastfmListened {
  mbid: string | null;
  name: string;
  plays: number;
}

export interface LastfmClientOptions {
  apiKey: string;
  url?: string;
  timeoutMs?: number;
}

export class LastfmClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor({ apiKey, url = LASTFM_URL, timeoutMs = TIMEOUT_MS }: LastfmClientOptions) {
    this.apiKey = apiKey;
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  /** Throws a readable LastfmError unless Last.fm accepts the key. */
  async validateKey(): Promise<void> {
    await this.call('chart.gettopartists', { limit: '1' });
  }

  /** The user's canonical name and scrobble count, or null when Last.fm has no such user. */
  async user(name: string): Promise<{ name: string; playcount: number } | null> {
    try {
      const body = userSchema.parse(await this.call('user.getinfo', { user: name }));
      return { name: body.user.name, playcount: body.user.playcount ?? 0 };
    } catch (error) {
      if (error instanceof LastfmError && error.code === NOT_FOUND) return null;
      throw error;
    }
  }

  /**
   * Artists similar to one artist, strongest first. Looks it up by MBID, then
   * by name when Last.fm does not know the MBID; unknown artists have none.
   */
  async similarArtists(artist: { mbid: string; name: string }, limit = 100): Promise<LastfmSimilar[]> {
    const lookups: Record<string, string>[] = [{ mbid: artist.mbid }, { artist: artist.name, autocorrect: '1' }];
    for (const params of lookups) {
      try {
        const body = similarSchema.parse(await this.call('artist.getsimilar', { ...params, limit: String(limit) }));
        return (body.similarartists.artist ?? []).map((a) => ({ mbid: a.mbid || null, name: a.name, match: a.match }));
      } catch (error) {
        if (!(error instanceof LastfmError && error.code === NOT_FOUND)) throw error;
      }
    }
    return [];
  }

  /** A user's most played artists of all time. */
  async userTopArtists(username: string, limit = 100): Promise<LastfmListened[]> {
    try {
      const body = topArtistsSchema.parse(
        await this.call('user.gettopartists', { user: username, period: 'overall', limit: String(limit) }),
      );
      return (body.topartists.artist ?? []).map((a) => ({ mbid: a.mbid || null, name: a.name, plays: a.playcount }));
    } catch (error) {
      if (error instanceof LastfmError && error.code === NOT_FOUND) return [];
      throw error;
    }
  }

  private async call(method: string, params: Record<string, string>): Promise<unknown> {
    const query = new URLSearchParams({ method, ...params, api_key: this.apiKey, format: 'json' });
    let body: unknown;
    try {
      const response = await limiterFor(this.apiKey).schedule(() =>
        fetchBuffered(`${this.url}?${query}`, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          timeoutMs: this.timeoutMs,
        }),
      );
      body = await response.json().catch(() => undefined);
      if (!response.ok && !errorSchema.safeParse(body).success) {
        throw new LastfmError(`Last.fm returned an error (HTTP ${response.status}). Try again shortly.`);
      }
    } catch (error) {
      if (error instanceof LastfmError) throw error;
      throw new LastfmError('Could not reach Last.fm. Check that Offbeat can reach the internet.');
    }
    const failure = errorSchema.safeParse(body);
    if (failure.success) throw describe(failure.data.error, failure.data.message);
    return body;
  }
}

function describe(code: number, message: string | undefined): LastfmError {
  if (INVALID_KEY.has(code)) {
    return new LastfmError('Last.fm rejected that API key. Copy it again from your Last.fm API account page.', code);
  }
  if (code === RATE_LIMITED) return new LastfmError('Last.fm is limiting requests right now. Try again in a minute.', code);
  if (code === NOT_FOUND) return new LastfmError(message ?? 'Last.fm has no record of that.', code);
  return new LastfmError(`Last.fm returned an error: ${message ?? `code ${code}`}`, code);
}
