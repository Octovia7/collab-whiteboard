import { defineConfig } from 'vitest/config';

// Tests that need Docker Postgres (`docker compose up -d`). One file at a time: they share
// the whiteboard_test database and truncate it between tests.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
