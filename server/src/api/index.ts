import type { FastifyPluginAsync } from 'fastify';
import { statusRoutes } from './status.js';

/** Mounted at `<BASE_URL>/api/v1`. Register one module per resource here. */
export const api: FastifyPluginAsync = async (app) => {
  await app.register(statusRoutes);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'Not Found', message: `No route for ${request.method} ${request.url}` });
  });
};
