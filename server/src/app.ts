import Fastify, { type FastifyServerOptions } from 'fastify';
import { Activity, type ActivityOptions } from './activity/activity.js';
import { api } from './api/index.js';
import { Catalog, type CatalogOptions } from './catalog/catalog.js';
import type { LoginLimiter } from './auth/login-limiter.js';
import type { Config } from './config.js';
import { SecretBox } from './crypto/secret-box.js';
import type { Db } from './db/index.js';
import { ArtworkCache } from './library/artwork.js';
import { ImageUrls } from './library/image-urls.js';
import { MUSICBRAINZ_URL, MusicBrainzClient } from './integrations/musicbrainz/client.js';
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
    catalog: Catalog;
    activity: Activity;
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
  /** Override in tests to point at a fake MusicBrainz without the 1 request per second pacing. */
  musicbrainz?: { url: string; minTimeMs: number };
  catalog?: CatalogOptions;
  activity?: ActivityOptions;
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
  musicbrainz = { url: MUSICBRAINZ_URL, minTimeMs: 1100 },
  catalog = {},
  activity = {},
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
  const imageUrls = new ImageUrls(secretKey);
  app.decorate('imageUrls', imageUrls);
  app.decorate(
    'library',
    new Library(db, settings, app.log, upstreamTimeoutMs, (ids) => {
      for (const id of ids) void artwork.removeArtist(id);
    }),
  );

  // One client, so MusicBrainz's one request per second holds across every caller.
  const musicbrainzClient = new MusicBrainzClient(db, app.log, musicbrainz.url, musicbrainz.minTimeMs);
  app.decorate(
    'catalog',
    new Catalog(
      db,
      settings,
      app.library,
      musicbrainzClient,
      imageUrls,
      app.log,
      { timeoutMs: upstreamTimeoutMs, ...catalog },
    ),
  );

  // Polling starts in index.ts (and in tests that need it), not here.
  app.decorate(
    'activity',
    new Activity(db, settings, app.library, app.catalog, musicbrainzClient, imageUrls, app.log, activity),
  );
  app.addHook('onClose', async () => app.activity.stop());

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
