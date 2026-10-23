import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db:5432/wb',
  REDIS_URL: 'redis://redis:6379',
  JWT_SECRET: 'x'.repeat(40),
  ALLOWED_ORIGINS: 'https://board.example.com',
};

const issues = (env: Record<string, string | undefined>) => {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
};

describe('loadConfig', () => {
  it('gives development defaults so `pnpm dev` just works', () => {
    const c = loadConfig({});
    expect(c.production).toBe(false);
    expect(c.databaseUrl).toContain(':55432/');
    expect(c.cookieSecure).toBe(false);
    expect(c.bcryptCost).toBe(12);
  });

  it('refuses to start in production without database, redis, secret and origins', () => {
    const found = issues({ NODE_ENV: 'production' }).join('\n');
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'ALLOWED_ORIGINS']) expect(found).toContain(name);
  });

  it('accepts a complete production config, with secure cookies by default', () => {
    const c = loadConfig(prod);
    expect(c.production).toBe(true);
    expect(c.cookieSecure).toBe(true);
    expect(c.allowedOrigins).toEqual(['https://board.example.com']);
  });

  it('rejects invalid values with a message per problem', () => {
    expect(issues({ ...prod, PORT: 'eighty' })).toEqual([expect.stringContaining('PORT')]);
    expect(issues({ ...prod, JWT_SECRET: 'short' })).toEqual([expect.stringContaining('at least 32')]);
    expect(issues({ ...prod, DATABASE_URL: 'mysql://x/y' })).toEqual([expect.stringContaining('postgres://')]);
    expect(issues({ ...prod, ALLOWED_ORIGINS: 'not a url' })).toEqual([expect.stringContaining('ALLOWED_ORIGINS')]);
    expect(issues({ ...prod, BCRYPT_COST: '30' })).toEqual([expect.stringContaining('BCRYPT_COST')]);
    expect(issues({ ...prod, COOKIE_SECURE: 'yes' })).toEqual([expect.stringContaining('COOKIE_SECURE')]);
  });

  it('treats empty values as missing', () => {
    expect(issues({ ...prod, JWT_SECRET: '' }).join()).toContain('JWT_SECRET');
  });

  it('never allows fault injection or the development secret in production', () => {
    expect(issues({ ...prod, WB_FAULT_ACK_DELAY_MS: '100' }).join()).toContain('not allowed in production');
    expect(issues({ ...prod, JWT_SECRET: 'dev-only-secret-change-me-dev-only-secret' }).join()).toContain('development secret');
  });

  it('never echoes secret values in its errors', () => {
    const secret = 'super-secret-value';
    expect(issues({ ...prod, JWT_SECRET: secret }).join()).not.toContain(secret);
  });
});
