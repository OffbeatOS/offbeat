import type { StatusResponse } from '@offbeat/shared';
import type { FastifyPluginAsync } from 'fastify';
import { VERSION } from '../version.js';

export const statusRoutes: FastifyPluginAsync = async (app) => {
  app.get('/status', async (): Promise<StatusResponse> => {
    // Touch the database so the healthcheck fails if SQLite is unusable.
    app.db.$client.prepare('select 1').get();
    return { status: 'ok', version: VERSION, uptime: Math.round(process.uptime()) };
  });
};
