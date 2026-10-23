import { defineConfig, devices } from '@playwright/test';

// Smoke test against an already running production stack (docker-compose.prod.yml).
// It only uses what a real user can: the production build has no window.__board.
export default defineConfig({
  testDir: './tests/smoke',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results/smoke',
  use: {
    baseURL: process.env.SMOKE_URL ?? 'http://localhost:8080',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
});
