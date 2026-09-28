import { eq, sql } from 'drizzle-orm';
import { issueTemporaryPassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/sessions.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';

/**
 * Account recovery for the admin CLI (`offbeat reset-password`, `list-users`,
 * `make-admin`). Works while Offbeat is running: the database is in WAL mode
 * with a busy timeout, so a write waits for the server instead of failing.
 */
export class CommandError extends Error {}

function findUser(db: Db, username: string) {
  const user = db
    .select()
    .from(users)
    .where(sql`${users.username} = ${username} collate nocase`)
    .get();
  if (!user) throw new CommandError(`No user named "${username}". Run \`offbeat list-users\` to see who exists.`);
  return user;
}

/** Same as Reset Password in Settings, Users: a temporary password, shown once, and signed out everywhere. */
export async function resetPassword(db: Db, username: string) {
  const user = findUser(db, username);
  const temporary = await issueTemporaryPassword();
  db.update(users)
    .set({ passwordHash: temporary.passwordHash, mustChangePassword: true, temporaryPasswordExpiresAt: temporary.expiresAt })
    .where(eq(users.id, user.id))
    .run();
  deleteUserSessions(db, user.id);
  return { username: user.username, role: user.role, password: temporary.password, expiresAt: temporary.expiresAt };
}

export function listUsers(db: Db) {
  return db
    .select({ username: users.username, role: users.role, lastSeenAt: users.lastSeenAt })
    .from(users)
    .orderBy(users.createdAt, users.id)
    .all();
}

/** For when no admin can sign in: someone else becomes one. */
export function makeAdmin(db: Db, username: string) {
  const user = findUser(db, username);
  if (user.role === 'admin') return { username: user.username, changed: false };
  db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id)).run();
  return { username: user.username, changed: true };
}
