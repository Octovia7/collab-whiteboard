import { ConfigError, loadConfig } from '../config';
import { connect, runMigrations } from './client';

/** `pnpm -F server db:migrate` (and `node dist/migrate.js` in the image): applies pending migrations. */
async function main(): Promise<void> {
  const config = loadConfig();
  const { pool } = connect(config.databaseUrl);
  try {
    await runMigrations(pool, config.migrationsDir);
    console.log(JSON.stringify({ level: 'info', msg: 'migrations applied' }));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
