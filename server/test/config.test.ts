import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeBaseUrl } from '../src/config.js';

describe('normalizeBaseUrl', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['music', '/music'],
    ['/music/', '/music'],
    ['//apps/music//', '/apps/music'],
  ])('%j becomes %j', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it('rejects characters that would break the base href', () => {
    expect(() => normalizeBaseUrl('/mu"sic')).toThrow(/unsupported/);
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: 3001,
      baseUrl: '',
      trustProxy: false,
      logLevel: 'info',
      configDir: path.resolve('./config'),
    });
  });

  it('parses deployment variables', () => {
    const config = loadConfig({
      PORT: '8080',
      BASE_URL: '/music/',
      TRUST_PROXY: 'true',
      LOG_LEVEL: 'debug',
      CONFIG_DIR: '/app/config',
    });
    expect(config).toMatchObject({
      port: 8080,
      baseUrl: '/music',
      trustProxy: true,
      logLevel: 'debug',
      configDir: path.resolve('/app/config'),
    });
  });

  it('reports invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});
