import { connect, runMigrations } from '../../packages/server/src/db/client';
import { ensureDatabase, truncateAll } from '../integration/db';
import { E2E_DB_URL, killServer, startServer } from './server';

/** Fresh whiteboard_e2e database, then the server. Needs `docker compose up -d`. */
export default async function globalSetup(): Promise<void> {
  await ensureDatabase('whiteboard_e2e');
  const { pool } = connect(E2E_DB_URL);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
  await truncateAll(E2E_DB_URL);
  await killServer(); // a server left over from an aborted run
  await startServer();
}
