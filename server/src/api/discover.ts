import type { BlockedItem, BlocklistResponse, DiscoverResponse, TagPage } from '@offbeat/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MBID } from '../catalog/releases.js';
import { currentClient } from '../integrations/lidarr/settings.js';
import { HttpError, parse } from './errors.js';

const modeQuery = z.object({ mode: z.enum(['safer', 'balanced', 'deeper']).default('balanced') });
const feedbackBody = z.object({
  mbid: z.string().regex(MBID, 'not a MusicBrainz id'),
  value: z.enum(['up', 'down']).nullable(),
});
const source = z.enum(['discover', 'search', 'settings', 'tag']);
const blockBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artist'), mbid: z.string().regex(MBID, 'not a MusicBrainz id'), name: z.string().trim().min(1).max(200), source }),
  z.object({ kind: z.literal('tag'), name: z.string().trim().min(1, 'which tag?').max(64, 'that tag is too long'), source }),
]);
const blockParams = z.object({ id: z.string().regex(/^[1-9]\d{0,9}$/, 'not a blocklist entry').transform(Number) });
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

  /** Thumbs up, thumbs down, or clear. A thumbs down takes the artist out of the picks now. */
  app.post('/discover/feedback', async (request, reply) => {
    const { mbid, value } = parse(feedbackBody, request.body);
    app.discovery.rate(request.user!.id, mbid.toLowerCase(), value);
    return reply.code(204).send();
  });

  app.get('/blocklist', async (request): Promise<BlocklistResponse> => app.discovery.blocklist(request.user!.id));

  app.post('/blocklist', async (request, reply): Promise<BlockedItem> => {
    const body = parse(blockBody, request.body);
    const item = app.discovery.block(request.user!.id, body);
    return reply.code(201).send(item);
  });

  app.delete('/blocklist/:id', async (request, reply) => {
    const { id } = parse(blockParams, request.params);
    if (!app.discovery.unblock(request.user!.id, id)) throw new HttpError(404, 'That is not on your blocklist');
    return reply.code(204).send();
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
