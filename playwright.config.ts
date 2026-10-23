import { defineConfig, devices } from '@playwright/test';

// Dedicated ports so E2E never collides with `pnpm dev` (3001 / 5173) or other local apps.
// The server (:3101) is started by globalSetup and controlled by the tests (tests/e2e/server.ts),
// because some tests kill and restart it. Needs Docker Postgres (`docker compose up -d`).
const SERVER_PORT = 3101;
const CLIENT_PORT = 5199;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // Tests share one server (and restart it), so run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
  globalSetup: './tests/e2e/globalSetup.ts',
  globalTeardown: './tests/e2e/globalTeardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${CLIENT_PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `pnpm -F @whiteboard/client exec vite --port ${CLIENT_PORT} --strictPort --host 127.0.0.1`,
    env: { WHITEBOARD_SERVER: `http://127.0.0.1:${SERVER_PORT}` },
    url: `http://127.0.0.1:${CLIENT_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
