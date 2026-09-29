import Bottleneck from 'bottleneck';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/index.js';
import { musicbrainzCache } from '../../db/schema.js';
import { USER_AGENT } from '../../version.js';
import { fetchBuffered } from '../http.js';

export const MUSICBRAINZ_URL = 'https://musicbrainz.org/ws/2';
const FRESH_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export class MusicBrainzError extends Error {}
/** MusicBrainz has no such entity (HTTP 404). */
export class MusicBrainzNotFound extends MusicBrainzError {}

const artistSearchSchema = z.object({
  artists: z.array(z.object({ id: z.string(), name: z.string(), disambiguation: z.string().nullish(), score: z.number().nullish() })),
});
const artistGenresSchema = z.object({
  genres: z.array(z.object({ name: z.string(), count: z.number() })).nullish(),
});

const releaseGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  'primary-type': z.string().nullish(),
  'secondary-types': z.array(z.string()).nullish(),
  'first-release-date': z.string().nullish(),
  'artist-credit': z
    .array(z.object({ name: z.string(), artist: z.object({ id: z.string(), name: z.string() }) }))
    .nullish(),
});
export type MbReleaseGroup = z.infer<typeof releaseGroupSchema>;

const browseSchema = z.object({
  'release-group-count': z.number(),
  'release-groups': z.array(releaseGroupSchema),
});

const releaseGroupSearchSchema = z.object({ 'release-groups': z.array(releaseGroupSchema) });
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const releasesSchema = z.object({
  releases: z.array(
    z.object({
      id: z.string(),
      date: z.string().nullish(),
      status: z.string().nullish(),
      media: z
        .array(
          z.object({
            position: z.number().nullish(),
            tracks: z
              .array(
                z.object({
                  number: z.string().nullish(),
                  title: z.string(),
                  length: z.number().nullish(),
                }),
              )
              .nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

export interface MbTrack {
  position: string;
  title: string;
  durationMs: number | null;
}

/**
 * MusicBrainz, within its rules: one request per second (shared by every
 * caller), a descriptive User-Agent, and an aggressive cache. A failed
 * request falls back to a stale cached copy when there is one.
 */
export class MusicBrainzClient {
  private readonly limiter: Bottleneck;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly baseUrl = MUSICBRAINZ_URL,
    minTimeMs = 1100,
  ) {
    this.limiter = new Bottleneck({ maxConcurrent: 1, minTime: minTimeMs });
  }

  /**
   * An artist's release groups. `albumsOnly` asks for primary type Album
   * (live albums and compilations included): usually one page instead of
   * several for a big artist, each page a second of rate limit.
   */
  async releaseGroups(artistMbid: string, { albumsOnly = false } = {}): Promise<MbReleaseGroup[]> {
    const all: MbReleaseGroup[] = [];
    const type = albumsOnly ? '&type=album' : '';
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await this.get(
        `release-group?artist=${encodeURIComponent(artistMbid)}${type}&limit=100&offset=${offset}&fmt=json`,
        browseSchema,
      );
      all.push(...page['release-groups']);
      if (all.length >= page['release-group-count'] || page['release-groups'].length === 0) break;
    }
    return all;
  }

  /**
   * Release groups by MBID, up to 40 in one request (a search on their ids),
   * for their types and dates. Ones MusicBrainz does not return are left out.
   */
  async releaseGroupsById(mbids: string[]): Promise<MbReleaseGroup[]> {
    const ids = [...new Set(mbids.filter((m) => MBID.test(m)).map((m) => m.toLowerCase()))];
    const found: MbReleaseGroup[] = [];
    for (let i = 0; i < ids.length; i += 40) {
      const batch = ids.slice(i, i + 40);
      const query = encodeURIComponent(`rgid:(${batch.join(' OR ')})`);
      const result = await this.get(`release-group?query=${query}&limit=100&fmt=json`, releaseGroupSearchSchema);
      found.push(...result['release-groups'].filter((g) => batch.includes(g.id)));
    }
    return found;
  }

  async releaseGroup(mbid: string): Promise<MbReleaseGroup> {
    return this.get(`release-group/${encodeURIComponent(mbid)}?inc=artist-credits&fmt=json`, releaseGroupSchema);
  }

  /**
   * An artist's genres from MusicBrainz's curated list (not free-form tags),
   * with how many editors voted for each. Unknown artists have none.
   */
  async artistGenres(mbid: string): Promise<{ name: string; count: number }[]> {
    try {
      const artist = await this.get(`artist/${encodeURIComponent(mbid)}?inc=genres&fmt=json`, artistGenresSchema);
      return [...(artist.genres ?? [])].sort((a, b) => b.count - a.count);
    } catch (error) {
      if (error instanceof MusicBrainzNotFound) return [];
      throw error;
    }
  }

  /**
   * Artists tagged with a genre, most relevant first. MusicBrainz genres are
   * tags on its curated list, so this is an artist search on that tag.
   */
  async artistsTagged(tag: string, limit = 100): Promise<{ mbid: string; name: string; disambiguation: string | null }[]> {
    // Quotes and backslashes would break out of the Lucene phrase.
    const query = encodeURIComponent(`tag:"${tag.replace(/["\\]/g, '')}"`);
    const result = await this.get(`artist?query=${query}&limit=${limit}&fmt=json`, artistSearchSchema);
    return result.artists.map((a) => ({ mbid: a.id, name: a.name, disambiguation: a.disambiguation || null }));
  }

  /** Track list of a release group's earliest official release. */
  async tracks(releaseGroupMbid: string): Promise<MbTrack[]> {
    const { releases } = await this.get(
      `release?release-group=${encodeURIComponent(releaseGroupMbid)}&inc=recordings+media&status=official&limit=25&fmt=json`,
      releasesSchema,
    );
    const release = [...releases].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))[0];
    const media = release?.media ?? [];
    return media.flatMap((medium, discIndex) =>
      (medium.tracks ?? []).map((track, i) => ({
        position: media.length > 1 ? `${medium.position ?? discIndex + 1}-${track.number ?? i + 1}` : String(track.number ?? i + 1),
        title: track.title,
        durationMs: track.length ?? null,
      })),
    );
  }

  private async get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    const cached = this.db.select().from(musicbrainzCache).where(eq(musicbrainzCache.path, path)).get();
    if (cached && Date.now() - cached.fetchedAt.getTime() < FRESH_FOR_MS) {
      return schema.parse(JSON.parse(cached.body));
    }
    try {
      const body = await this.limiter.schedule(() => this.fetchJson(path));
      const parsed = schema.parse(body);
      this.db
        .insert(musicbrainzCache)
        .values({ path, body: JSON.stringify(body), fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: musicbrainzCache.path,
          set: { body: JSON.stringify(body), fetchedAt: new Date() },
        })
        .run();
      return parsed;
    } catch (error) {
      if (cached) {
        this.log.warn({ err: error, path }, 'MusicBrainz failed; serving a stale copy');
        return schema.parse(JSON.parse(cached.body));
      }
      throw error instanceof MusicBrainzError ? error : new MusicBrainzError('MusicBrainz could not be reached. Try again shortly.');
    }
  }

  private async fetchJson(path: string): Promise<unknown> {
    const response = await fetchBuffered(`${this.baseUrl}/${path}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeoutMs: TIMEOUT_MS,
    });
    if (response.status === 404) throw new MusicBrainzNotFound('MusicBrainz has no record of that');
    if (response.status === 503) throw new MusicBrainzError('MusicBrainz is busy. Try again shortly.');
    if (!response.ok) throw new MusicBrainzError(`MusicBrainz returned HTTP ${response.status}`);
    return response.json();
  }
}
