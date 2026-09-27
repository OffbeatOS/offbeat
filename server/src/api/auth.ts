import type { CurrentUser } from '@offbeat/shared';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { type SessionCookieOptions, SESSION_COOKIE, clearSessionCookie, setSessionCookie } from '../auth/guard.js';
import { LoginLimiter } from '../auth/login-limiter.js';
import { verifyPassword } from '../auth/password.js';
import { createSession, deleteExpiredSessions, deleteSession } from '../auth/sessions.js';
import { users } from '../db/schema.js';
import { HttpError, parse } from './errors.js';

const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export interface AuthRoutesOptions {
  cookie: SessionCookieOptions;
  limiter?: LoginLimiter;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, { cookie, limiter = new LoginLimiter() }) => {
  app.post('/auth/login', { config: { public: true } }, async (request, reply): Promise<CurrentUser> => {
    const retryAfter = limiter.retryAfter(request.ip);
    if (retryAfter > 0) {
      throw new HttpError(429, 'Too many failed sign-in attempts. Try again in a few minutes.', {
        'retry-after': String(retryAfter),
      });
    }

    const { username, password } = parse(loginBody, request.body);
    const user = app.db
      .select()
      .from(users)
      .where(sql`${users.username} = ${username} collate nocase`)
      .get();

    if (!(await verifyPassword(user?.passwordHash ?? null, password)) || !user) {
      limiter.fail(request.ip);
      throw new HttpError(401, 'Incorrect username or password');
    }

    limiter.succeed(request.ip);
    deleteExpiredSessions(app.db);
    const session = createSession(app.db, user.id);
    setSessionCookie(request, reply, session.token, session.expiresAt, cookie);
    return { id: user.id, username: user.username, role: user.role };
  });

  // Public so a stale or expired cookie can always be cleared.
  app.post('/auth/logout', { config: { public: true } }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) deleteSession(app.db, token);
    clearSessionCookie(reply, cookie);
    return reply.code(204).send();
  });

  // Public and never 401, so the app can ask "who am I" without a console error.
  app.get('/auth/me', { config: { public: true } }, async (request): Promise<{ user: CurrentUser | null }> => {
    return { user: request.user };
  });
};
