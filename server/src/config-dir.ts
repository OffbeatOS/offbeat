import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ConfigPaths {
  root: string;
  database: string;
  secretKey: string;
  imageCache: string;
  logs: string;
}

export function configPaths(root: string): ConfigPaths {
  return {
    root,
    database: path.join(root, 'offbeat.db'),
    secretKey: path.join(root, 'secret.key'),
    imageCache: path.join(root, 'cache', 'images'),
    logs: path.join(root, 'logs'),
  };
}

/** Creates the config directory layout if missing. Safe to call on every boot. */
export function prepareConfigDir(root: string): ConfigPaths {
  const paths = configPaths(root);
  for (const dir of [paths.root, paths.imageCache, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

const SECRET_BYTES = 32;

/**
 * Returns the key used to encrypt stored API keys, generating it on first boot.
 * Losing this file makes stored secrets unreadable, so it is never regenerated
 * once it exists.
 */
export function loadOrCreateSecretKey(file: string): Buffer {
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(SECRET_BYTES).toString('hex') + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  if (key.length !== SECRET_BYTES) {
    throw new Error(`${file} is corrupt: expected ${SECRET_BYTES * 2} hex characters`);
  }
  return key;
}
