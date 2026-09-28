import fastifyCookie from '@fastify/cookie';
import type { FastifyContextConfig, FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { LoginLimiter } from '../auth/login-limiter.js';
import { DEFAULT_SESSION_COOKIE, registerAuthGuard } from '../auth/guard.js';
import { activityRoutes } from './activity.js';
import { authRoutes } from './auth.js';
import { catalogRoutes } from './catalog.js';
import { discoverRoutes } from './discover.js';
import { signInSettingsRoutes } from './sign-in-settings.js';
import { userRoutes } from './users.js';
import { HttpError, apiErrorHandler, errorBody } from './errors.js';
import { libraryRoutes } from './library.js';
import { lidarrSettingsRoutes } from './lidarr-settings.js';
import { listeningRoutes } from './listening.js';
import { setupRoutes } from './setup.js';
import { statusRoutes } from './status.js';

export interface ApiOptions {
  baseUrl: string;
  /** Session cookie name; defaults to offbeat_session. */
  sessionCookie?: string;
  loginLimiter?: LoginLimiter;
  upstreamTimeoutMs?: number;
  /** Last.fm API base, overridden in tests. */
  lastfmUrl?: string;
  /** Filled with every API route and its access config, so tests can check none is left unguarded. */
  routeTable?: ApiRouteInfo[];
}

export interface ApiRouteInfo {
  method: string;
  url: string;
  config: FastifyContextConfig;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense alongside SameSite=Lax cookies: a cross-site page can only send
 * form-encoded, multipart, or text/plain bodies without a CORS preflight, so
 * every state-changing request must declare JSON, even when it has no body.
 */
function requireJsonForWrites(app: FastifyInstance) {
  app.removeContentTypeParser('text/plain');
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const type = request.headers['content-type'] ?? '';
    if (!/^application\/json\s*(;|$)/i.test(type)) {
      throw new HttpError(415, 'Send the request body as application/json');
    }
  });
}

/**
 * Mounted at `<BASE_URL>/api/v1`. Every route requires a signed-in user unless
 * its config sets `public: true`. Register one module per resource here.
 */
export const api: FastifyPluginAsync<ApiOptions> = async (
  app,
  { baseUrl, sessionCookie = DEFAULT_SESSION_COOKIE, loginLimiter, upstreamTimeoutMs, lastfmUrl, routeTable },
) => {
  const cookie = { baseUrl, name: sessionCookie };
  if (routeTable) {
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (method !== 'HEAD') routeTable.push({ method, url: route.url, config: (route.config ?? {}) as FastifyContextConfig });
      }
    });
  }

  await app.register(fastifyCookie);
  requireJsonForWrites(app);
  registerAuthGuard(app, cookie);
  app.setErrorHandler(apiErrorHandler);

  await app.register(statusRoutes);
  await app.register(setupRoutes, { cookie });
  await app.register(authRoutes, { cookie, limiter: loginLimiter });
  await app.register(lidarrSettingsRoutes, { timeoutMs: upstreamTimeoutMs });
  await app.register(listeningRoutes, { lastfmUrl, timeoutMs: upstreamTimeoutMs });
  await app.register(libraryRoutes);
  await app.register(catalogRoutes);
  await app.register(activityRoutes);
  await app.register(discoverRoutes);
  await app.register(userRoutes, { cookie });
  await app.register(signInSettingsRoutes);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorBody(404, `No route for ${request.method} ${request.url}`));
  });
};
