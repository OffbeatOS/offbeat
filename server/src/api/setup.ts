import {
  type CurrentUser,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type SetupState,
  USERNAME_PATTERN,
} from '@offbeat/shared';
import { count } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { toCurrentUser } from '../auth/permissions.js';
import { type SessionCookieOptions, setSessionCookie } from '../auth/guard.js';
import { hashPassword } from '../auth/password.js';
import { isLidarrConfigured } from '../integrations/lidarr/settings.js';
import { createSession } from '../auth/sessions.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { HttpError, parse } from './errors.js';

const adminBody = z.object({
  username: z
    .string()
    .trim()
    .regex(USERNAME_PATTERN, 'use 3 to 32 letters, numbers, dots, dashes, or underscores'),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

const hasUsers = (db: Db) => (db.select({ n: count() }).from(users).get()?.n ?? 0) > 0;

export const setupRoutes: FastifyPluginAsync<{ cookie: SessionCookieOptions }> = async (app, { cookie }) => {
  app.get('/setup/state', { config: { public: true } }, async (): Promise<SetupState> => {
    return { needsAdmin: !hasUsers(app.db), lidarrConfigured: isLidarrConfigured(app.settings) };
  });

  /** Creates the first admin and signs them in. Refused once any user exists. */
  app.post('/setup/admin', { config: { public: true } }, async (request, reply): Promise<CurrentUser> => {
    if (hasUsers(app.db)) throw new HttpError(409, 'Setup is already complete. Sign in instead.');
    const { username, password } = parse(adminBody, request.body);
    const passwordHash = await hashPassword(password);

    // Re-check inside a transaction: two tabs racing through setup must not
    // both create an admin while the (async) hash was being computed.
    const user = app.db.transaction((tx) => {
      if (hasUsers(tx as unknown as Db)) return null;
      return tx
        .insert(users)
        .values({ username, passwordHash, role: 'admin' })
        .returning({ id: users.id, username: users.username, role: users.role, permissions: users.permissions })
        .get();
    });
    if (!user) throw new HttpError(409, 'Setup is already complete. Sign in instead.');

    const session = createSession(app.db, user.id);
    setSessionCookie(request, reply, session.token, session.expiresAt, cookie);
    return reply.code(201).send(toCurrentUser(user));
  });
};
