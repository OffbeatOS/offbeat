import Fastify, { type FastifyServerOptions } from 'fastify';
import { Activity, type ActivityOptions } from './activity/activity.js';
import { type ApiRouteInfo, api } from './api/index.js';
import { findDockerStandIns } from './auth/sign-in.js';
import { Catalog, type CatalogOptions } from './catalog/catalog.js';
import { Discovery, type DiscoveryOptions } from './discovery/discovery.js';
import type { LoginLimiter } from './auth/login-limiter.js';
import type { Config } from './config.js';
import { SecretBox } from './crypto/secret-box.js';
import type { Db } from './db/index.js';
import { ArtworkCache } from './library/artwork.js';
import { ImageUrls } from './library/image-urls.js';
import type { LastfmClient } from './integrations/lastfm/client.js';
import { lastfmClientFor } from './integrations/lastfm/settings.js';
import { currentClient } from './integrations/lidarr/settings.js';
import { Notifier, type NotifierOptions } from './notifications/notifier.js';
import { MusicFiles } from './library/music-files.js';
import { Transcoder } from './streaming/transcoder.js';
import { ListenBrainzClient } from './integrations/listenbrainz/client.js';
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
    discovery: Discovery;
    notifier: Notifier;
    musicFiles: MusicFiles;
    transcoder: Transcoder;
    /** Listening and similarity sources. Last.fm is null until an admin connects it. */
    sources: { lastfm: () => LastfmClient | null; listenbrainz: ListenBrainzClient };
  }
}

export interface AppOptions {
  config: Pick<Config, 'baseUrl' | 'trustProxy' | 'logLevel'> & Partial<Pick<Config, 'sessionCookie' | 'ffmpegPath'>>;
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
  /** Override in tests to point at fake Last.fm and ListenBrainz servers. */
  sources?: { lastfmUrl?: string; listenbrainzUrl?: string; listenbrainzLabsUrl?: string };
  discovery?: DiscoveryOptions;
  notifications?: NotifierOptions;
  /** Filled with every API route and its access config (for tests). */
  routeTable?: ApiRouteInfo[];
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
  sources = {},
  discovery = {},
  notifications = {},
  routeTable,
}: AppOptions) {
  const app = Fastify({
    logger: logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
  });

  app.decorate('db', db);
  const settings = new SettingsStore(db, new SecretBox(secretKey));
  app.decorate('settings', settings);
  app.decorate('sources', {
    lastfm: () => lastfmClientFor(settings, sources.lastfmUrl, upstreamTimeoutMs),
    listenbrainz: new ListenBrainzClient({
      url: sources.listenbrainzUrl,
      labsUrl: sources.listenbrainzLabsUrl,
      timeoutMs: upstreamTimeoutMs,
    }),
  });
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

  app.decorate(
    'activity',
    new Activity(db, settings, app.library, app.catalog, musicbrainzClient, imageUrls, app.log, activity),
  );
  // Polling runs for the life of the app, so no caller can forget to start it.
  app.addHook('onReady', async () => {
    if (activity.autoStart !== false) app.activity.start();
  });
  app.addHook('onClose', async () => app.activity.stop());

  app.decorate(
    'discovery',
    new Discovery(
      db,
      app.library,
      {
        lastfm: app.sources.lastfm,
        listenbrainz: app.sources.listenbrainz,
        lidarr: currentClient(settings),
        musicbrainz: musicbrainzClient,
      },
      imageUrls,
      app.log,
      discovery,
    ),
  );
  // The daily refresh runs for the life of the app.
  app.addHook('onReady', async () => app.discovery.start());

  // Discord and generic webhooks: fed by Activity (history, blocked imports) and Lidarr's calendar.
  // Audio comes from the music folders Lidarr manages, indexed by Lidarr's track files.
  app.decorate('musicFiles', new MusicFiles(settings, currentClient(settings), app.log));
  app.decorate('transcoder', new Transcoder(config.ffmpegPath ?? 'ffmpeg', app.log));

  app.decorate('notifier', new Notifier(db, settings, app.log, currentClient(settings), notifications));
  app.activity.observe({
    history: (records) => app.notifier.noticeHistory(records),
    attention: (items) => app.notifier.noticeAttention(items),
  });
  app.addHook('onReady', async () => app.notifier.start());
  app.addHook('onClose', async () => app.notifier.stop());
  app.addHook('onClose', async () => app.discovery.stop());

  // Docker addresses that stand for anyone never count as the local network (auth/network.ts).
  await findDockerStandIns();

  await app.register(api, {
    prefix: `${config.baseUrl}/api/v1`,
    baseUrl: config.baseUrl,
    sessionCookie: config.sessionCookie,
    loginLimiter,
    upstreamTimeoutMs,
    lastfmUrl: sources.lastfmUrl,
    routeTable,
  });

  if (webRoot) {
    await registerWeb(app, webRoot, config.baseUrl);
  }

  return app;
}
