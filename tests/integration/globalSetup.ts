import { connect, runMigrations } from '../../packages/server/src/db/client';
import { dbUrl, ensureDatabase } from './db';

/** Once per `pnpm test:integration` run: create and migrate the test database. */
export default async function setup(): Promise<void> {
  await ensureDatabase('whiteboard_test');
  const { pool } = connect(dbUrl('whiteboard_test'));
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
