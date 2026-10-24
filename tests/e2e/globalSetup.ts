import { connect, runMigrations } from '../../packages/server/src/db/client';
import { E2E_REDIS_URL, ensureDatabase, flushRedis, truncateAll } from '../integration/db';
import { existsSync } from 'node:fs';
import { CLIENT_BUILD, E2E_DB_URL, killServer, SERVER_BUNDLE, startServer } from './server';

/** Fresh whiteboard_e2e database and Redis db 2, then both servers. Needs `docker compose up -d`. */
export default async function globalSetup(): Promise<void> {
  for (const built of [SERVER_BUNDLE, CLIENT_BUILD]) {
    if (!existsSync(built)) throw new Error(`${built} is missing: run \`pnpm build:e2e\` (or \`pnpm test:e2e\`, which builds first)`);
  }
  await ensureDatabase('whiteboard_e2e');
  const { pool } = connect(E2E_DB_URL);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
  await truncateAll(E2E_DB_URL);
  await flushRedis(E2E_REDIS_URL);
  // Servers left over from an aborted run.
  await killServer(1);
  await killServer(2);
  await startServer({}, 1);
  await startServer({}, 2);
}
