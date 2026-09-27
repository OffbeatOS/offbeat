import type { StatusResponse } from '@offbeat/shared';
import type { FastifyPluginAsync } from 'fastify';
import { VERSION } from '../version.js';

export const statusRoutes: FastifyPluginAsync = async (app) => {
  app.get('/status', { config: { public: true } }, async (): Promise<StatusResponse> => {
    // Query the database so the Docker healthcheck fails if the SQLite binary
    // is missing, the file is unusable, or migrations never ran.
    const row = app.db.$client
      .prepare('select count(*) as applied from __drizzle_migrations')
      .get() as { applied: number };
    if (row.applied === 0) {
      throw new Error('Database has no applied migrations');
    }
    return { status: 'ok', version: VERSION, uptime: Math.round(process.uptime()) };
  });
};
