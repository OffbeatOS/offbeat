import {
  type CreatedUser,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PERMISSIONS,
  type Permission,
  type TemporaryPassword,
  USERNAME_PATTERN,
  type UserSummary,
} from '@offbeat/shared';
import { count, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { SessionCookieOptions } from '../auth/guard.js';
import { hashPassword, issueTemporaryPassword, verifyPassword } from '../auth/password.js';
import { TEMPORARY_EXPIRED, parsePermissions, temporaryExpired } from '../auth/permissions.js';
import { deleteUserSessions } from '../auth/sessions.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { HttpError, parse } from './errors.js';

const role = z.enum(['admin', 'user']);
const permissions = z.array(z.enum(PERMISSIONS as [Permission, ...Permission[]])).max(PERMISSIONS.length);
const createBody = z.object({
  username: z.string().trim().regex(USERNAME_PATTERN, 'use 3 to 32 letters, numbers, dots, dashes, or underscores'),
  role,
  permissions,
});
const updateBody = z
  .object({ role: role.optional(), permissions: permissions.optional() })
  .refine((b) => b.role !== undefined || b.permissions !== undefined, 'nothing to change');
const changePasswordBody = z.object({
  currentPassword: z.string().min(1, 'enter your current password').max(PASSWORD_MAX_LENGTH),
  newPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `use at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX_LENGTH),
});
const idParams = z.object({ id: z.string().regex(/^[1-9]\d{0,9}$/, 'not a user').transform(Number) });

const LAST_ADMIN = 'Offbeat needs at least one admin. Make someone else an admin first.';

/**
 * Settings, Users: admins manage accounts (every /users route is admin only).
 * Admins never choose passwords for other people: adding a user or resetting
 * a password makes a temporary one, shown once, which the user replaces at
 * their next sign-in (PUT /account/password).
 */
export const userRoutes: FastifyPluginAsync<{ cookie: SessionCookieOptions }> = async (app, { cookie }) => {
  const admin = { config: { role: 'admin' as const } };

  app.get('/users', admin, async (): Promise<UserSummary[]> =>
    app.db.select().from(users).orderBy(users.createdAt, users.id).all().map(summary),
  );

  app.post('/users', admin, async (request, reply): Promise<CreatedUser> => {
    const body = parse(createBody, request.body);
    const temporary = await issueTemporaryPassword();
    const created = app.db.transaction((tx) => {
      const taken = tx
        .select({ id: users.id })
        .from(users)
        .where(sql`${users.username} = ${body.username} collate nocase`)
        .get();
      if (taken) return null;
      return tx
        .insert(users)
        .values({
          username: body.username,
          passwordHash: temporary.passwordHash,
          role: body.role,
          permissions: JSON.stringify(ordered(body.permissions)),
          mustChangePassword: true,
          temporaryPasswordExpiresAt: temporary.expiresAt,
        })
        .returning()
        .get();
    });
    if (!created) throw new HttpError(409, 'That username is taken');
    return reply
      .code(201)
      .send({ user: summary(created), temporaryPassword: temporary.password, expiresAt: temporary.expiresAt.toISOString() });
  });

  app.patch('/users/:id', admin, async (request): Promise<UserSummary> => {
    const { id } = parse(idParams, request.params);
    const body = parse(updateBody, request.body);
    const updated = app.db.transaction((tx) => {
      const user = tx.select().from(users).where(eq(users.id, id)).get();
      if (!user) throw new HttpError(404, 'That user does not exist');
      if (user.role === 'admin' && body.role === 'user' && adminCount(tx as unknown as Db) <= 1) {
        throw new HttpError(409, LAST_ADMIN);
      }
      return tx
        .update(users)
        .set({
          ...(body.role ? { role: body.role } : {}),
          ...(body.permissions ? { permissions: JSON.stringify(ordered(body.permissions)) } : {}),
        })
        .where(eq(users.id, id))
        .returning()
        .get();
    });
    return summary(updated);
  });

  /** A new temporary password for someone else, shown once; signs them out everywhere. */
  app.post('/users/:id/password', admin, async (request): Promise<TemporaryPassword> => {
    const { id } = parse(idParams, request.params);
    if (id === request.user!.id) throw new HttpError(409, 'Change your own password in Settings, Account');
    const temporary = await issueTemporaryPassword();
    const changed =
      app.db
        .update(users)
        .set({ passwordHash: temporary.passwordHash, mustChangePassword: true, temporaryPasswordExpiresAt: temporary.expiresAt })
        .where(eq(users.id, id))
        .run().changes > 0;
    if (!changed) throw new HttpError(404, 'That user does not exist');
    deleteUserSessions(app.db, id);
    return { temporaryPassword: temporary.password, expiresAt: temporary.expiresAt.toISOString() };
  });

  /**
   * Removes an account and signs it out. Their Discover, feedback, and
   * blocklist go with them; what they requested keeps their name.
   */
  app.delete('/users/:id', admin, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    if (id === request.user!.id) throw new HttpError(409, 'You cannot remove your own account');
    app.db.transaction((tx) => {
      const user = tx.select().from(users).where(eq(users.id, id)).get();
      if (!user) throw new HttpError(404, 'That user does not exist');
      if (user.role === 'admin' && adminCount(tx as unknown as Db) <= 1) throw new HttpError(409, LAST_ADMIN);
      tx.delete(users).where(eq(users.id, id)).run();
    });
    return reply.code(204).send();
  });

  /**
   * Anyone changes their own password, and must after signing in with a
   * temporary one. Other sessions end; this one stays signed in.
   */
  app.put('/account/password', { config: { passwordChange: true } }, async (request, reply) => {
    const body = parse(changePasswordBody, request.body);
    const me = app.db.select().from(users).where(eq(users.id, request.user!.id)).get()!;
    if (!(await verifyPassword(me.passwordHash, body.currentPassword))) {
      throw new HttpError(422, 'Your current password is not right');
    }
    if (temporaryExpired(me)) throw new HttpError(422, TEMPORARY_EXPIRED);
    if (body.newPassword === body.currentPassword) throw new HttpError(422, 'Choose a password different from the current one');
    const passwordHash = await hashPassword(body.newPassword);
    app.db
      .update(users)
      .set({ passwordHash, mustChangePassword: false, temporaryPasswordExpiresAt: null })
      .where(eq(users.id, me.id))
      .run();
    deleteUserSessions(app.db, me.id, request.cookies[cookie.name]);
    return reply.code(204).send();
  });
};

function adminCount(db: Db): number {
  return db.select({ n: count() }).from(users).where(eq(users.role, 'admin')).get()?.n ?? 0;
}

function ordered(list: Permission[]): Permission[] {
  return PERMISSIONS.filter((p) => list.includes(p));
}

function summary(row: typeof users.$inferSelect): UserSummary {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    permissions: parsePermissions(row.permissions),
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    mustChangePassword: row.mustChangePassword,
    temporaryPasswordExpiresAt: row.temporaryPasswordExpiresAt ? row.temporaryPasswordExpiresAt.toISOString() : null,
  };
}
