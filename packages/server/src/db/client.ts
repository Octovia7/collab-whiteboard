import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export interface Database {
  db: Db;
  pool: pg.Pool;
}

/** BIGINT comes back as a string by default; our seqs fit comfortably in a JS number. */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function connect(url: string): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    // Fail fast instead of hanging when Postgres is down or overloaded; callers retry.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000, // server-side: Postgres cancels a statement running longer
    query_timeout: 15_000, // client-side backstop
  });
  // An idle client losing its connection emits 'error' on the pool; without a listener that
  // would crash the process. The next query simply gets a fresh connection.
  pool.on('error', () => {});
  return { pool, db: drizzle(pool, { schema }) };
}

export const DEFAULT_MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** Arbitrary constant: the advisory lock id that serializes migrations. */
const MIGRATION_LOCK_ID = 7_418_202;

/**
 * Applies pending migrations. Holds a Postgres advisory lock while doing so, so several server
 * replicas starting at once (a deploy) migrate one at a time instead of racing.
 */
export async function runMigrations(pool: pg.Pool, migrationsFolder = DEFAULT_MIGRATIONS_DIR): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await migrate(drizzle(client, { schema }), { migrationsFolder });
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}
