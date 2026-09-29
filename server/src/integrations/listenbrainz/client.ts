import Bottleneck from 'bottleneck';
import { z } from 'zod';
import { USER_AGENT } from '../../version.js';
import { fetchBuffered } from '../http.js';

export const LISTENBRAINZ_URL = 'https://api.listenbrainz.org/1';
/** Similar-artist data lives on the ListenBrainz Labs host. */
export const LISTENBRAINZ_LABS_URL = 'https://labs.api.listenbrainz.org';
/** The session-based similarity model ListenBrainz itself uses for "similar artists". */
const SIMILARITY_ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
const TIMEOUT_MS = 10_000;

/** ListenBrainz needs no key; stay well inside its per-IP rate limit. */
const limiter = new Bottleneck({ maxConcurrent: 2, minTime: 250 });

export class ListenBrainzError extends Error {}

const listenCountSchema = z.object({ payload: z.object({ count: z.number() }) });
const similarSchema = z.array(z.object({ artist_mbid: z.string(), name: z.string(), score: z.number() }));
const popularitySchema = z.array(
  z.object({ artist_mbid: z.string(), total_user_count: z.number().nullish(), total_listen_count: z.number().nullish() }),
);
const releaseGroupPopularitySchema = z.array(
  z.object({ release_group_mbid: z.string(), total_user_count: z.number().nullish() }),
);
const topReleaseGroupsSchema = z.array(
  z.object({ release_group_mbid: z.string().nullish(), release_group: z.object({ type: z.string().nullish() }).nullish() }),
);
const topArtistsSchema = z.object({
  payload: z.object({
    artists: z.array(
      z.object({
        artist_mbid: z.string().nullish(),
        artist_mbids: z.array(z.string()).nullish(),
        artist_name: z.string(),
        listen_count: z.number(),
      }),
    ),
  }),
});

/** An artist ListenBrainz users play in the same sessions, with its raw strength. */
export interface ListenBrainzSimilar {
  mbid: string;
  name: string;
  score: number;
}

export interface ListenedArtist {
  mbid: string | null;
  name: string;
  plays: number;
}

export interface ListenBrainzClientOptions {
  url?: string;
  labsUrl?: string;
  timeoutMs?: number;
}

export class ListenBrainzClient {
  private readonly url: string;
  private readonly labsUrl: string;
  private readonly timeoutMs: number;

  constructor({ url = LISTENBRAINZ_URL, labsUrl = LISTENBRAINZ_LABS_URL, timeoutMs = TIMEOUT_MS }: ListenBrainzClientOptions = {}) {
    this.url = url;
    this.labsUrl = labsUrl;
    this.timeoutMs = timeoutMs;
  }

  /** Artists similar to one artist, strongest first. Unknown artists have none. */
  async similarArtists(mbid: string): Promise<ListenBrainzSimilar[]> {
    const query = new URLSearchParams({ artist_mbids: mbid, algorithm: SIMILARITY_ALGORITHM });
    const response = await this.send(`${this.labsUrl}/similar-artists/json?${query}`);
    if (!response.ok) throw new ListenBrainzError(`ListenBrainz similar artists failed (HTTP ${response.status})`);
    const parsed = similarSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new ListenBrainzError('ListenBrainz similar artists answered in an unexpected format');
    return parsed.data
      .filter((a) => a.artist_mbid !== mbid)
      .map((a) => ({ mbid: a.artist_mbid, name: a.name, score: a.score }));
  }

  /** How many ListenBrainz users play each artist; artists it has no data for are left out. */
  async popularity(mbids: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (let i = 0; i < mbids.length; i += 100) {
      const response = await this.send(`${this.url}/popularity/artist`, {
        method: 'POST',
        body: JSON.stringify({ artist_mbids: mbids.slice(i, i + 100) }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new ListenBrainzError(`ListenBrainz popularity failed (HTTP ${response.status})`);
      const parsed = popularitySchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw new ListenBrainzError('ListenBrainz popularity answered in an unexpected format');
      for (const row of parsed.data) if (row.total_user_count != null) result.set(row.artist_mbid, row.total_user_count);
    }
    return result;
  }

  /** How many ListenBrainz users play each release group; unknown ones are left out. */
  async releaseGroupPopularity(mbids: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (let i = 0; i < mbids.length; i += 100) {
      const response = await this.send(`${this.url}/popularity/release-group`, {
        method: 'POST',
        body: JSON.stringify({ release_group_mbids: mbids.slice(i, i + 100) }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new ListenBrainzError(`ListenBrainz album popularity failed (HTTP ${response.status})`);
      const parsed = releaseGroupPopularitySchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw new ListenBrainzError('ListenBrainz album popularity answered in an unexpected format');
      for (const row of parsed.data) if (row.total_user_count != null) result.set(row.release_group_mbid, row.total_user_count);
    }
    return result;
  }

  /**
   * An artist's release groups, most listened first, with their primary
   * type. ListenBrainz does not say which are live albums or compilations.
   */
  async topReleaseGroups(artistMbid: string): Promise<{ mbid: string; type: string | null }[]> {
    const response = await this.get(`popularity/top-release-groups-for-artist/${encodeURIComponent(artistMbid)}`);
    if (!response.ok) throw new ListenBrainzError(`ListenBrainz top albums failed (HTTP ${response.status})`);
    const parsed = topReleaseGroupsSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new ListenBrainzError('ListenBrainz top albums answered in an unexpected format');
    return parsed.data.flatMap((r) => (r.release_group_mbid ? [{ mbid: r.release_group_mbid, type: r.release_group?.type ?? null }] : []));
  }

  /** A user's most played artists of all time. Users without stats yet have none. */
  async userTopArtists(username: string, count = 100): Promise<ListenedArtist[]> {
    const response = await this.get(`stats/user/${encodeURIComponent(username)}/artists?count=${count}&range=all_time`);
    if (response.status === 204 || response.status === 404) return [];
    if (!response.ok) throw new ListenBrainzError(`ListenBrainz stats failed (HTTP ${response.status})`);
    const parsed = topArtistsSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) return [];
    return parsed.data.payload.artists.map((a) => ({
      mbid: a.artist_mbid ?? a.artist_mbids?.[0] ?? null,
      name: a.artist_name,
      plays: a.listen_count,
    }));
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

  private get(path: string): Promise<Response> {
    return this.send(`${this.url}/${path}`);
  }

  private async send(url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
    try {
      return await limiter.schedule(() =>
        fetchBuffered(url, {
          ...init,
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init.headers },
          timeoutMs: this.timeoutMs,
        }),
      );
    } catch {
      throw new ListenBrainzError('Could not reach ListenBrainz. Check that Offbeat can reach the internet.');
    }
  }
}
