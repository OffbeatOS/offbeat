import type { DiscoverResponse } from '@offbeat/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parse } from './errors.js';

const modeQuery = z.object({ mode: z.enum(['safer', 'balanced', 'deeper']).default('balanced') });

/** Each signed-in user's own recommendations. */
export const discoverRoutes: FastifyPluginAsync = async (app) => {
  app.get('/discover', async (request): Promise<DiscoverResponse> => {
    const { mode } = parse(modeQuery, request.query);
    const userId = request.user!.id;
    const current = app.discovery.read(userId, mode);
    // Nothing yet: start the first refresh, and say so.
    if (!current.generatedAt && !current.refreshing && !current.error) {
      void app.discovery.refresh(userId).catch(() => undefined);
      return { ...current, refreshing: true };
    }
    return current;
  });

  /** Refresh now instead of waiting for the daily run. Answers at once; poll GET /discover for the result. */
  app.post('/discover/refresh', async (request, reply) => {
    void app.discovery.refresh(request.user!.id).catch(() => undefined);
    return reply.code(202).send({ refreshing: true });
  });
};
