import type { AlbumDetail, ArtistDetail, ReleaseStatus, SearchResponse } from '@offbeat/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MBID } from '../catalog/releases.js';
import { LidarrError } from '../integrations/lidarr/client.js';
import { MusicBrainzError } from '../integrations/musicbrainz/client.js';
import { HttpError, parse } from './errors.js';

const mbidParams = z.object({ mbid: z.string().regex(MBID, 'not a MusicBrainz id') });
const searchQuery = z.object({ q: z.string().trim().min(2, 'type at least 2 characters').max(100) });
const addAlbumBody = z.object({ artistMbid: z.string().regex(MBID, 'not a MusicBrainz id') });
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

  app.get('/search', async (request): Promise<SearchResponse> => {
    const { q } = parse(searchQuery, request.query);
    return upstream(request, () => app.catalog.search(q));
  });

  app.get('/artists/:mbid', async (request): Promise<ArtistDetail> => {
    const { mbid } = parse(mbidParams, request.params);
    return upstream(request, () => app.catalog.artist(mbid.toLowerCase()));
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
    return upstream(request, () => app.catalog.album(mbid.toLowerCase()));
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
   * Starts adding an album and answers at once: an album add can take a while
   * (Lidarr has to load a new artist first). The result arrives as an
   * add-result event on /events and shows in Activity.
   */
  app.post('/albums/:mbid', async (request, reply) => {
    const { mbid } = parse(mbidParams, request.params);
    const { artistMbid } = parse(addAlbumBody, request.body);
    await upstream(request, () =>
      app.activity.startAlbumAdd(mbid.toLowerCase(), artistMbid.toLowerCase(), request.user?.id ?? null),
    );
    const status: ReleaseStatus = { kind: 'adding' };
    return reply.code(202).send({ status });
  });
};
