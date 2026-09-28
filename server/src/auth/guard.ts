import type { CurrentUser, Permission, UserRole } from '@offbeat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../api/errors.js';
import { can } from './permissions.js';
import { resolveSession } from './sessions.js';

/** Default session cookie name; change it with SESSION_COOKIE when several instances share a host. */
export const DEFAULT_SESSION_COOKIE = 'offbeat_session';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without signing in. Routes are private unless they opt out. */
    public?: boolean;
    /** Minimum role; defaults to any signed-in user. */
    role?: UserRole;
    /** A Member needs this permission (admins have them all). */
    permission?: Permission;
  }
  interface FastifyRequest {
    user: CurrentUser | null;
  }
}

export interface SessionCookieOptions {
  /** Normalized BASE_URL, so the cookie is scoped to Offbeat's subpath. */
  baseUrl: string;
  /** Cookie name. Browsers share cookies across ports, so two instances on one host need different names. */
  name: string;
}

export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  { baseUrl, name }: SessionCookieOptions,
) {
  reply.setCookie(name, token, {
    path: `${baseUrl}/`,
    httpOnly: true,
    sameSite: 'lax',
    secure: request.protocol === 'https',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, { baseUrl, name }: SessionCookieOptions) {
  reply.clearCookie(name, { path: `${baseUrl}/` });
}

/**
 * Resolves `request.user` from the session cookie and enforces each route's
 * `public`, `role`, and `permission` config. Must be registered inside the API scope after
 * @fastify/cookie.
 */
const PERMISSION_DENIED: Record<Permission, string> = {
  'add-artists': 'Your account cannot add artists. Ask an admin.',
  'add-albums': 'Your account cannot add albums. Ask an admin.',
  'change-monitoring': 'Your account cannot change monitoring. Ask an admin.',
  delete: 'Your account cannot remove downloads. Ask an admin.',
  flows: 'Your account cannot use flows. Ask an admin.',
};

export function registerAuthGuard(app: FastifyInstance, cookie: SessionCookieOptions) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[cookie.name];
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
    if (config.permission && !can(request.user, config.permission)) {
      throw new HttpError(403, PERMISSION_DENIED[config.permission]);
    }
  });
}
