import type { CurrentUser, Permission, SignInVia, UserRole } from '@offbeat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../api/errors.js';
import { can } from './permissions.js';
import { resolveSession } from './sessions.js';
import { autoLoginUser, identityFromNetwork } from './sign-in.js';

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
    /** Reachable while signed in with a temporary password (choosing a new one). */
    passwordChange?: boolean;
  }
  interface FastifyRequest {
    user: CurrentUser | null;
    /** How `user` was signed in. */
    authVia: SignInVia | null;
    /** A username the trusted proxy vouched for that has no Offbeat account. */
    unknownProxyUser: string | null;
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
 * Resolves `request.user` (proxy header from a trusted proxy, then the session
 * cookie, then local network auto-login; see sign-in.ts) and enforces each route's
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

export const NO_ACCOUNT = 'There is no Offbeat account for this user. Ask an admin.';

export function registerAuthGuard(app: FastifyInstance, cookie: SessionCookieOptions) {
  app.decorateRequest('user', null);
  app.decorateRequest('authVia', null);
  app.decorateRequest('unknownProxyUser', null);
  // Sign-in methods beyond passwords need the settings store (absent in some tests).
  const store = app.hasDecorator('settings') ? app.settings : null;

  app.addHook('onRequest', async (request, reply) => {
    const network = store ? await identityFromNetwork(app.db, store, request.socket.remoteAddress, request.headers) : null;
    if (network && network !== 'proxy-silent') {
      // The trusted proxy decides who this is, whatever cookie the browser sends.
      request.user = network.user;
      request.authVia = network.via;
      request.unknownProxyUser = network.unknownProxyUser;
    } else {
      const token = request.cookies[cookie.name];
      if (token) {
        const session = resolveSession(app.db, token);
        if (session) {
          request.user = session.user;
          request.authVia = 'password';
          if (session.refreshed) setSessionCookie(request, reply, token, session.expiresAt, cookie);
        } else {
          clearSessionCookie(reply, cookie);
        }
      }
      // No proxy said who this is, and no session: the local network, if enabled and verified.
      if (!request.user && store && network !== 'proxy-silent') {
        request.user = autoLoginUser(app.db, store, request.socket.remoteAddress, request.headers);
        if (request.user) request.authVia = 'auto-login';
      }
    }

    if (request.is404) return;
    const config = request.routeOptions.config;
    if (config.public) return;
    if (!request.user) {
      throw new HttpError(401, request.unknownProxyUser ? NO_ACCOUNT : 'Sign in to continue');
    }
    // Only a password sign-in can be holding a temporary password.
    if (request.user.mustChangePassword && request.authVia === 'password' && !config.passwordChange) {
      throw new HttpError(403, 'Choose a new password first');
    }
    if (config.role === 'admin' && request.user.role !== 'admin') {
      throw new HttpError(403, 'Only admins can do that');
    }
    if (config.permission && !can(request.user, config.permission)) {
      throw new HttpError(403, PERMISSION_DENIED[config.permission]);
    }
  });
}
