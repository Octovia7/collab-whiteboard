import { defineConfig, devices } from '@playwright/test';

// Dedicated ports so E2E never collides with `pnpm dev` (3001 / 5173) or other local apps.
// E2E runs against built output, like production: `pnpm test:e2e` first runs `pnpm build:e2e`
// (the server bundle, and the client built with `--mode e2e`, which keeps window.__board).
// Two servers (:3101, :3102) run from the bundle; globalSetup starts them and the tests control
// them (tests/e2e/server.ts), because some tests kill and restart them. The built client is
// served statically by `vite preview`, one per server (:5199 -> :3101, the default baseURL;
// :5200 -> :3102), which also proxies /api and /ws, so a test chooses a tab's server by the
// origin it opens. Needs Docker Postgres and Redis (`docker compose up -d`).
const CLIENTS = [
  { client: 5199, server: 3101 },
  { client: 5200, server: 3102 },
];

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // Tests share the servers (and restart them), so run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
  globalSetup: './tests/e2e/globalSetup.ts',
  globalTeardown: './tests/e2e/globalTeardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${CLIENTS[0]?.client}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: CLIENTS.map(({ client, server }) => ({
    command: `pnpm -F @whiteboard/client exec vite preview --mode e2e --port ${client} --strictPort --host 127.0.0.1`,
    env: { WHITEBOARD_SERVER: `http://127.0.0.1:${server}` },
    url: `http://127.0.0.1:${client}`,
    reuseExistingServer: false,
    timeout: 60_000,
  })),
});
