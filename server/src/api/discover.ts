import type { DiscoverResponse, TagPage } from '@offbeat/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentClient } from '../integrations/lidarr/settings.js';
import { parse } from './errors.js';

const modeQuery = z.object({ mode: z.enum(['safer', 'balanced', 'deeper']).default('balanced') });
const tagParams = z.object({ tag: z.string().trim().min(1, 'which tag?').max(64, 'that tag is too long') });

/** Each signed-in user's own recommendations, and the tag pages they lead to. */
export const discoverRoutes: FastifyPluginAsync = async (app) => {
  const lidarrClient = currentClient(app.settings);

  app.get('/discover', async (request): Promise<DiscoverResponse> => {
    const { mode } = parse(modeQuery, request.query);
    const userId = request.user!.id;
    const current = app.discovery.read(userId, mode);
    // Nothing yet: start the first refresh, and say so.
    if (!current.generatedAt && !current.refreshing && !current.error) {
      void app.discovery.refresh(userId).catch(() => undefined);
      return { ...current, refreshing: true };
    }
    const albums = await app.catalog.withStatuses(current.albums);
    warm(albums.map((a) => a.mbid));
    return { ...current, albums };
  });

  /** Refresh now instead of waiting for the daily run. Answers at once; poll GET /discover for the result. */
  app.post('/discover/refresh', async (request, reply) => {
    void app.discovery.refresh(request.user!.id).catch(() => undefined);
    return reply.code(202).send({ refreshing: true });
  });

  app.get('/tags/:tag', async (request): Promise<TagPage> => {
    const { tag } = parse(tagParams, request.params);
    const page = await app.discovery.tag(request.user!.id, tag);
    const albums = await app.catalog.withStatuses(page.albums);
    warm(albums.map((a) => a.mbid));
    return { tag, ...page, albums };
  });

  /** Start fetching the covers the browser is about to ask for (see ArtworkCache.warmAlbums). */
  function warm(mbids: string[]) {
    app.artwork.warmAlbums(
      mbids.map((mbid) => ({ mbid })),
      lidarrClient,
    );
  }
};
