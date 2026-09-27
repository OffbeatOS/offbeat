import Fastify, { type FastifyServerOptions } from 'fastify';
import { api } from './api/index.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { registerWeb } from './web.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

export interface AppOptions {
  config: Pick<Config, 'baseUrl' | 'trustProxy' | 'logLevel'>;
  db: Db;
  /** Directory holding the built Angular app, or null to serve only the API. */
  webRoot: string | null;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({ config, db, webRoot, logger }: AppOptions) {
  const app = Fastify({
    logger: logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
  });

  app.decorate('db', db);

  await app.register(api, { prefix: `${config.baseUrl}/api/v1` });

  if (webRoot) {
    await registerWeb(app, webRoot, config.baseUrl);
  }

  return app;
}
