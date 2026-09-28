import path from 'node:path';
import { z } from 'zod';

/**
 * Deployment settings read from the environment. Everything else (Lidarr,
 * API keys, discovery tuning) lives in the database and is edited in the UI.
 */
export interface Config {
  port: number;
  host: string;
  configDir: string;
  /** Subpath for reverse proxies, normalized to `''` or `/segment` with no trailing slash. */
  baseUrl: string;
  trustProxy: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Session cookie name, for running several instances on one host. */
  sessionCookie: string;
}

const booleanish = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().min(1).default('0.0.0.0'),
  CONFIG_DIR: z.string().min(1).default('./config'),
  BASE_URL: z.string().default(''),
  TRUST_PROXY: booleanish.default(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SESSION_COOKIE: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'use up to 64 letters, numbers, dashes, or underscores')
    .default('offbeat_session'),
});

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  if (!/^[A-Za-z0-9._~\-/]+$/.test(trimmed)) {
    throw new Error(`BASE_URL contains unsupported characters: "${raw}"`);
  }
  return `/${trimmed}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const vars = parsed.data;
  return {
    port: vars.PORT,
    host: vars.HOST,
    configDir: path.resolve(vars.CONFIG_DIR),
    baseUrl: normalizeBaseUrl(vars.BASE_URL),
    trustProxy: vars.TRUST_PROXY,
    logLevel: vars.LOG_LEVEL,
    sessionCookie: vars.SESSION_COOKIE,
  };
}
