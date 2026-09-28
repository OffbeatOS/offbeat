import type { AlbumDetail, ArtistDetail, ReleaseStatus, SearchResponse } from '@offbeat/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MBID } from '../catalog/releases.js';
import { LidarrError } from '../integrations/lidarr/client.js';
import { MusicBrainzError } from '../integrations/musicbrainz/client.js';
import { HttpError, parse } from './errors.js';
import { currentClient } from '../integrations/lidarr/settings.js';

/** Album cover URLs as `ImageUrls.releaseGroupCover` writes them. */
const COVER_URL = /api\/v1\/images\/album\/([0-9a-f-]{36})(?:\?src=(lidarr))?/g;
const mbidParams = z.object({ mbid: z.string().regex(MBID, 'not a MusicBrainz id') });
const searchQuery = z.object({ q: z.string().trim().min(2, 'type at least 2 characters').max(100) });
const addAlbumBody = z.object({
  artistMbid: z.string().regex(MBID, 'not a MusicBrainz id'),
  // Confirms monitoring an unmonitored artist again even though other albums would resume.
  resumeMonitoring: z.boolean().default(false),
});
// PATCH bodies for artists and albums share one shape.
const updateArtistBody = z.object({ monitored: z.boolean() });

/**
 * Search, artist, and album pages, plus one-click adds. Upstream problems come
 * back as readable 422 or 503 errors, never 401, so they cannot look like an
 * expired session.
 */
export const catalogRoutes: FastifyPluginAsync = async (app) => {
  const upstream = async <T>(request: FastifyRequest, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LidarrError) {
        request.log.warn({ reason: error.message }, 'Lidarr request failed');
        throw new HttpError(422, error.message);
      }
      if (error instanceof MusicBrainzError) throw new HttpError(503, error.message);
      throw error;
    }
  };

  const lidarrClient = currentClient(app.settings);

  /** Starts fetching the album covers in a response the browser is about to render. */
  function warmCovers<T>(response: T): T {
    const covers = [...JSON.stringify(response).matchAll(COVER_URL)].map((m) => ({
      mbid: m[1]!,
      preferLidarr: m[2] === 'lidarr',
    }));
    app.artwork.warmAlbums(covers, lidarrClient);
    return response;
  }

  app.get('/search', async (request): Promise<SearchResponse> => {
    const { q } = parse(searchQuery, request.query);
    return warmCovers(await upstream(request, () => app.catalog.search(q)));
  });

  app.get('/artists/:mbid', async (request): Promise<ArtistDetail> => {
    const { mbid } = parse(mbidParams, request.params);
    return warmCovers(await upstream(request, () => app.catalog.artist(mbid.toLowerCase())));
  });

  app.post('/artists/:mbid', async (request): Promise<ArtistDetail> => {
    const { mbid } = parse(mbidParams, request.params);
    return upstream(request, () => app.catalog.addArtist(mbid.toLowerCase(), request.user?.id ?? null));
  });

  app.patch('/artists/:mbid', async (request): Promise<ArtistDetail> => {
    const { mbid } = parse(mbidParams, request.params);
    const { monitored } = parse(updateArtistBody, request.body);
    return upstream(request, () => app.catalog.setMonitored(mbid.toLowerCase(), monitored));
  });

  app.get('/albums/:mbid', async (request): Promise<AlbumDetail> => {
    const { mbid } = parse(mbidParams, request.params);
    return warmCovers(await upstream(request, () => app.catalog.album(mbid.toLowerCase())));
  });

  app.patch('/albums/:mbid', async (request): Promise<AlbumDetail> => {
    const { mbid } = parse(mbidParams, request.params);
    const { monitored } = parse(updateArtistBody, request.body);
    return upstream(request, () => app.catalog.setAlbumMonitored(mbid.toLowerCase(), monitored));
  });

  app.post('/albums/:mbid/search', async (request, reply) => {
    const { mbid } = parse(mbidParams, request.params);
    await upstream(request, () => app.catalog.searchAlbum(mbid.toLowerCase()));
    void app.activity.expectMovement();
    return reply.code(202).send({ queued: true });
  });

  /**
   * Starts adding an album and answers at once, unless the artist is
   * unmonitored in Lidarr with other albums still monitored: monitoring it
   * again would resume those too, so that needs `resumeMonitoring` (409 first).
   * An album add can take a while (Lidarr has to load a new artist first). The result arrives as an
   * add-result event on /events and shows in Activity.
   */
  app.post('/albums/:mbid', async (request, reply) => {
    const { mbid } = parse(mbidParams, request.params);
    const { artistMbid, resumeMonitoring } = parse(addAlbumBody, request.body);
    if (!resumeMonitoring) {
      const resumed = await upstream(request, () => app.catalog.albumsResumedBy(mbid.toLowerCase(), artistMbid.toLowerCase()));
      if (resumed.length) throw new HttpError(409, resumesMessage(resumed));
    }
    await upstream(request, () =>
      app.activity.startAlbumAdd(mbid.toLowerCase(), artistMbid.toLowerCase(), request.user?.id ?? null),
    );
    const status: ReleaseStatus = { kind: 'adding' };
    return reply.code(202).send({ status });
  });
};

/** Explains which albums monitoring the artist again would resume (at most three named). */
export function resumesMessage(titles: string[]): string {
  const shown = titles.slice(0, 3);
  const more = titles.length - shown.length;
  const list = more ? `${shown.join(', ')} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
  const count = titles.length === 1 ? '1 other album' : `${titles.length} other albums`;
  return `This will also resume monitoring ${count} by this artist in Lidarr: ${list}.`;
}
