import type { CurrentUser, UserRole } from '@offbeat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../api/errors.js';
import { resolveSession } from './sessions.js';

export const SESSION_COOKIE = 'offbeat_session';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without signing in. Routes are private unless they opt out. */
    public?: boolean;
    /** Minimum role; defaults to any signed-in user. */
    role?: UserRole;
  }
  interface FastifyRequest {
    user: CurrentUser | null;
  }
}

export interface SessionCookieOptions {
  /** Normalized BASE_URL, so the cookie is scoped to Offbeat's subpath. */
  baseUrl: string;
}

export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  { baseUrl }: SessionCookieOptions,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: `${baseUrl}/`,
    httpOnly: true,
    sameSite: 'lax',
    secure: request.protocol === 'https',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, { baseUrl }: SessionCookieOptions) {
  reply.clearCookie(SESSION_COOKIE, { path: `${baseUrl}/` });
}

/**
 * Resolves `request.user` from the session cookie and enforces each route's
 * `public` and `role` config. Must be registered inside the API scope after
 * @fastify/cookie.
 */
export function registerAuthGuard(app: FastifyInstance, cookie: SessionCookieOptions) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const session = resolveSession(app.db, token);
      if (session) {
        request.user = session.user;
        if (session.refreshed) setSessionCookie(request, reply, token, session.expiresAt, cookie);
      } else {
        clearSessionCookie(reply, cookie);
      }
    }

    if (request.is404) return;
    const config = request.routeOptions.config;
    if (config.public) return;
    if (!request.user) throw new HttpError(401, 'Sign in to continue');
    if (config.role === 'admin' && request.user.role !== 'admin') {
      throw new HttpError(403, 'Only admins can do that');
    }
  });
}
