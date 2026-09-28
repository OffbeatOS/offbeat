import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth/password.js';
import { createSession } from '../src/auth/sessions.js';
import { openDatabase } from '../src/db/index.js';
import { sessions, users } from '../src/db/schema.js';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A config folder with a database, like a real install. */
function install() {
  const dir = mkdtempSync(path.join(tmpdir(), 'offbeat-cli-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'offbeat.db'));
  const [admin] = db.insert(users).values([{ username: 'Admin', passwordHash: 'x', role: 'admin' }, { username: 'sam', passwordHash: 'x', role: 'user' }]).returning().all();
  createSession(db, admin!.id);
  db.$client.close();
  return dir;
}

/** Runs the real CLI (from source) as its own process, the way an admin would. */
function cli(configDir: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: SERVER,
      env: { ...process.env, CONFIG_DIR: configDir },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

describe('offbeat CLI', () => {
  it('resets a password while the server holds a write lock: waits, then works like the UI reset', async () => {
    const dir = install();
    // Stand-in for the running server, mid-write, for a second and a half.
    const server = new Database(path.join(dir, 'offbeat.db'));
    server.pragma('busy_timeout = 5000');
    server.exec('BEGIN IMMEDIATE');
    server.prepare("UPDATE settings SET value = value WHERE key = 'none'").run();
    const release = setTimeout(() => server.exec('COMMIT'), 1500);

    const started = Date.now();
    const result = await cli(dir, 'reset-password', 'admin');
    clearTimeout(release);
    if (server.inTransaction) server.exec('COMMIT');
    server.close();

    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeGreaterThan(1400); // it waited for the lock instead of failing
    const password = result.out.match(/Temporary password for Admin: (\S+)/)?.[1];
    expect(password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect(result.out).toContain('shown only now');

    const db = openDatabase(path.join(dir, 'offbeat.db'));
    const admin = db.select().from(users).where(eq(users.username, 'Admin')).get()!;
    expect(await verifyPassword(admin.passwordHash, password!)).toBe(true);
    expect(admin.mustChangePassword).toBe(true);
    expect(admin.temporaryPasswordExpiresAt!.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(db.select().from(sessions).all()).toEqual([]); // signed out everywhere
    db.$client.close();
  }, 30_000);

  it('lists users and makes someone an admin', async () => {
    const dir = install();
    const listed = await cli(dir, 'list-users');
    expect(listed.code).toBe(0);
    expect(listed.out).toMatch(/Admin\s+Admin\s+never signed in/);
    expect(listed.out).toMatch(/sam\s+Member\s+never signed in/);

    expect((await cli(dir, 'make-admin', 'SAM')).out).toContain('sam is now an admin.');
    expect((await cli(dir, 'make-admin', 'sam')).out).toContain('sam is already an admin.');
    expect((await cli(dir, 'list-users')).out).toMatch(/sam\s+Admin/);
  }, 30_000);

  it('explains mistakes, and never creates a database in the wrong folder', async () => {
    const dir = install();
    const unknown = await cli(dir, 'reset-password', 'nobody');
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('No user named "nobody"');

    const usage = await cli(dir, 'reset-password');
    expect(usage.code).toBe(2);
    expect(usage.err).toContain('Usage: offbeat <command>');
    expect((await cli(dir, 'drop-tables')).code).toBe(2);

    const empty = mkdtempSync(path.join(tmpdir(), 'offbeat-cli-empty-'));
    dirs.push(empty);
    const missing = await cli(empty, 'list-users');
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('No Offbeat database at');
    expect(existsSync(path.join(empty, 'offbeat.db'))).toBe(false);
  }, 30_000);
});
