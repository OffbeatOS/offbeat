import type { PlayedTrack } from '@offbeat/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { LidarrError } from '../integrations/lidarr/client.js';
import { PlayNotFound } from '../listening/plays.js';
import { HttpError, parse } from './errors.js';

const playBody = z.object({
  trackFileId: z.number().int().positive(),
  playedAt: z.iso.datetime({ offset: true }),
});
const recentQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/** Plays in Offbeat: the player reports each one (Stream permission); anyone reads their own. */
export const playRoutes: FastifyPluginAsync = async (app) => {
  app.post('/plays', { config: { permission: 'stream' } }, async (request, reply) => {
    const { trackFileId, playedAt } = parse(playBody, request.body);
    try {
      await app.plays.record(request.user!.id, trackFileId, new Date(playedAt));
    } catch (error) {
      if (error instanceof PlayNotFound) throw new HttpError(404, error.message);
      if (error instanceof RangeError) throw new HttpError(400, error.message);
      if (error instanceof LidarrError) throw new HttpError(502, error.message);
      throw error;
    }
    return reply.code(204).send();
  });

  app.get('/plays', async (request): Promise<PlayedTrack[]> => {
    const { limit } = parse(recentQuery, request.query);
    return app.plays.recent(request.user!.id, limit);
  });
};
