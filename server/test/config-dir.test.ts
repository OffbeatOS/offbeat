import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSecretKey, prepareConfigDir } from '../src/config-dir.js';
import { openDatabase } from '../src/db/index.js';

let root: string;

beforeEach(() => {
  root = path.join(mkdtempSync(path.join(tmpdir(), 'offbeat-')), 'config');
});

afterEach(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('prepareConfigDir', () => {
  it('creates the directory layout', () => {
    const paths = prepareConfigDir(root);
    expect(existsSync(paths.imageCache)).toBe(true);
    expect(existsSync(paths.logs)).toBe(true);
    expect(paths.database).toBe(path.join(root, 'offbeat.db'));
  });
});

describe('loadOrCreateSecretKey', () => {
  it('generates a 32 byte key once and reuses it', () => {
    const { secretKey } = prepareConfigDir(root);
    const first = loadOrCreateSecretKey(secretKey);
    const second = loadOrCreateSecretKey(secretKey);
    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
    expect(readFileSync(secretKey, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a corrupt key instead of replacing it', () => {
    const { secretKey } = prepareConfigDir(root);
    writeFileSync(secretKey, 'not-a-key');
    expect(() => loadOrCreateSecretKey(secretKey)).toThrow(/corrupt/);
  });
});

describe('openDatabase', () => {
  it('applies migrations on a fresh file and is idempotent', () => {
    const { database } = prepareConfigDir(root);
    const db = openDatabase(database);
    const tables = db.$client
      .prepare("select name from sqlite_master where type = 'table' and name = 'settings'")
      .all();
    expect(tables).toHaveLength(1);
    db.$client.close();

    // Second boot against the same file must not fail or re-run migrations.
    openDatabase(database).$client.close();
  });
});
