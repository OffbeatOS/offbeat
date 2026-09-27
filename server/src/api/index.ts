import fastifyCookie from '@fastify/cookie';
import type { FastifyPluginAsync } from 'fastify';
import type { LoginLimiter } from '../auth/login-limiter.js';
import { registerAuthGuard } from '../auth/guard.js';
import { authRoutes } from './auth.js';
import { apiErrorHandler, errorBody } from './errors.js';
import { setupRoutes } from './setup.js';
import { statusRoutes } from './status.js';

export interface ApiOptions {
  baseUrl: string;
  loginLimiter?: LoginLimiter;
}

/**
 * Mounted at `<BASE_URL>/api/v1`. Every route requires a signed-in user unless
 * its config sets `public: true`. Register one module per resource here.
 */
export const api: FastifyPluginAsync<ApiOptions> = async (app, { baseUrl, loginLimiter }) => {
  const cookie = { baseUrl };

  await app.register(fastifyCookie);
  registerAuthGuard(app, cookie);
  app.setErrorHandler(apiErrorHandler);

  await app.register(statusRoutes);
  await app.register(setupRoutes, { cookie });
  await app.register(authRoutes, { cookie, limiter: loginLimiter });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorBody(404, `No route for ${request.method} ${request.url}`));
  });
};
