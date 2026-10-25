/** STATIC_DIR: the server serving the built client itself (the single-service Render demo). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './server';
import type { TestServer } from './server';

let dir: string;
let withClient: TestServer;
let apiOnly: TestServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Whiteboard</title><script type="module" src="/assets/index-abc123.js"></script>');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("app")');
  withClient = await startServer({ STATIC_DIR: dir });
  apiOnly = await startServer();
});
afterAll(async () => {
  await withClient.close();
  await apiOnly.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('serving the built client (STATIC_DIR)', () => {
  it('serves index.html at / with the app CSP, never cached', async () => {
    const res = await withClient.app.inject({ method: 'GET', url: '/?board=00000000-0000-0000-0000-000000000000' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>Whiteboard</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('serves fingerprinted assets with a long immutable cache', async () => {
    const res = await withClient.app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('serves nothing outside the directory, and the API is unchanged', async () => {
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/assets/../../package.json', '/missing.js']) {
      expect((await withClient.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    const me = await withClient.app.inject({ method: 'GET', url: '/api/me' });
    expect(me.statusCode).toBe(401);
    expect(me.json()).toEqual({ error: 'unauthorized' });
  });

  it('without STATIC_DIR the server is API-only, with the strict JSON CSP', async () => {
    const res = await apiOnly.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
  });
});
