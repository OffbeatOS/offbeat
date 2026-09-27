import type { CurrentUser } from '@offbeat/shared';
import { eq, lt } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Sessions are extended on use once less than this much time remains. */
const REFRESH_BELOW_MS = 15 * DAY_MS;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(db: Db, userId: number, now = new Date()) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.insert(sessions).values({ id: hashToken(token), userId, expiresAt }).run();
  return { token, expiresAt };
}

export interface ResolvedSession {
  user: CurrentUser;
  expiresAt: Date;
  /** True when the expiry moved, so the cookie should be re-issued. */
  refreshed: boolean;
}

/** Looks up the user behind a cookie token, expiring or extending the session as needed. */
export function resolveSession(db: Db, token: string, now = new Date()): ResolvedSession | null {
  const id = hashToken(token);
  const row = db
    .select({
      expiresAt: sessions.expiresAt,
      user: { id: users.id, username: users.username, role: users.role },
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, id))
    .get();

  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }
  if (row.expiresAt.getTime() - now.getTime() < REFRESH_BELOW_MS) {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id)).run();
    return { user: row.user, expiresAt, refreshed: true };
  }
  return { user: row.user, expiresAt: row.expiresAt, refreshed: false };
}

export function deleteSession(db: Db, token: string) {
  db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
}

export function deleteExpiredSessions(db: Db, now = new Date()) {
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
}
