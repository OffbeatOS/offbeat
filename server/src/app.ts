import Fastify, { type FastifyServerOptions } from 'fastify';
import { api } from './api/index.js';
import type { LoginLimiter } from './auth/login-limiter.js';
import type { Config } from './config.js';
import { SecretBox } from './crypto/secret-box.js';
import type { Db } from './db/index.js';
import { ArtworkCache } from './library/artwork.js';
import { Library } from './library/library.js';
import { SettingsStore } from './settings/store.js';
import { registerWeb } from './web.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    settings: SettingsStore;
    library: Library;
    artwork: ArtworkCache;
  }
}

export interface AppOptions {
  config: Pick<Config, 'baseUrl' | 'trustProxy' | 'logLevel'>;
  db: Db;
  /** Contents of `secret.key`; encrypts stored credentials. */
  secretKey: Buffer;
  /** Where proxied artwork is cached (config/cache/images). */
  imageCacheDir: string;
  /** Directory holding the built Angular app, or null to serve only the API. */
  webRoot: string | null;
  logger?: FastifyServerOptions['logger'];
  /** Override in tests to exercise throttling without real time passing. */
  loginLimiter?: LoginLimiter;
  /** Override in tests so unreachable upstreams fail fast. */
  upstreamTimeoutMs?: number;
}

export async function buildApp({
  config,
  db,
  secretKey,
  imageCacheDir,
  webRoot,
  logger,
  loginLimiter,
  upstreamTimeoutMs,
}: AppOptions) {
  const app = Fastify({
    logger: logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
  });

  app.decorate('db', db);
  const settings = new SettingsStore(db, new SecretBox(secretKey));
  app.decorate('settings', settings);
  app.decorate('library', new Library(db, settings, app.log, upstreamTimeoutMs));
  app.decorate('artwork', new ArtworkCache(imageCacheDir, app.log));

  await app.register(api, {
    prefix: `${config.baseUrl}/api/v1`,
    baseUrl: config.baseUrl,
    loginLimiter,
    upstreamTimeoutMs,
  });

  if (webRoot) {
    await registerWeb(app, webRoot, config.baseUrl);
  }

  return app;
}
