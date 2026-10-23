import { loadConfig } from '../config';
import { connect, runMigrations } from './client';

/** `pnpm -F server db:migrate`: applies pending migrations from packages/server/drizzle. */
const { pool, db } = connect(loadConfig().databaseUrl);
try {
  await runMigrations(db);
  console.log('migrations applied');
} finally {
  await pool.end();
}
