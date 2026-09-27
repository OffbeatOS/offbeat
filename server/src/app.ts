import Fastify, { type FastifyServerOptions } from 'fastify';
import { api } from './api/index.js';
import type { LoginLimiter } from './auth/login-limiter.js';
import type { Config } from './config.js';
import { SecretBox } from './crypto/secret-box.js';
import type { Db } from './db/index.js';
import { ArtworkCache } from './library/artwork.js';
import { ImageUrls } from './library/image-urls.js';
import { Library } from './library/library.js';
import { SettingsStore } from './settings/store.js';
import { registerWeb } from './web.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    settings: SettingsStore;
    library: Library;
    artwork: ArtworkCache;
    imageUrls: ImageUrls;
  }
}

export interface AppOptions {
  config: Pick<Config, 'baseUrl' | 'trustProxy' | 'logLevel'>;
  db: Db;
  /** Contents of `secret.key`; encrypts stored credentials. */
  secretKey: Buffer;
  /** Where proxied artwork is cached (config/cache/images). */
  imageCacheDir: string;
  /** Size cap for that cache; least recently used images are evicted past it. */
  imageCacheBytes?: number;
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
  imageCacheBytes,
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
  const artwork = new ArtworkCache(imageCacheDir, app.log, imageCacheBytes);
  app.decorate('artwork', artwork);
  app.decorate('imageUrls', new ImageUrls(secretKey));
  app.decorate(
    'library',
    new Library(db, settings, app.log, upstreamTimeoutMs, (ids) => {
      for (const id of ids) void artwork.removeArtist(id);
    }),
  );

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
