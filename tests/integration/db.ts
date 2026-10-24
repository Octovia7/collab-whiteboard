import { Redis } from 'ioredis';
import pg from 'pg';

/** Docker Postgres from docker-compose.yml (host port 55432; see the comment there). */
export const ADMIN_URL = 'postgres://whiteboard:whiteboard@127.0.0.1:55432/postgres';
export const dbUrl = (name: string) => `postgres://whiteboard:whiteboard@127.0.0.1:55432/${name}`;

/**
 * Docker Redis (host port 56379). Each suite gets its own logical database, like Postgres:
 * 0 is development, 1 integration tests, 2 E2E, so seq counters, rate limits and revoked
 * sessions never leak between them.
 */
export const TEST_REDIS_URL = 'redis://127.0.0.1:56379/1';
export const E2E_REDIS_URL = 'redis://127.0.0.1:56379/2';

/** Empties a test Redis database. Refuses anything but the two test databases. */
export async function flushRedis(url: string): Promise<void> {
  if (url !== TEST_REDIS_URL && url !== E2E_REDIS_URL) throw new Error(`refusing to flush ${url}`);
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5_000 });
  redis.on('error', () => {});
  try {
    await redis.connect();
    await redis.flushdb();
  } catch (err) {
    throw new Error(`Redis not reachable on 127.0.0.1:56379. Run \`docker compose up -d\`. (${(err as Error).message})`);
  } finally {
    redis.disconnect();
  }
}

/** Creates the database if needed. Refuses to manage anything but the two test databases. */
export async function ensureDatabase(name: string): Promise<void> {
  if (!/^whiteboard_(test|e2e)$/.test(name)) throw new Error(`refusing to manage database ${name}`);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Postgres not reachable on 127.0.0.1:55432. Run \`docker compose up -d\`. (${(err as Error).message})`);
  }
  try {
    const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (!rowCount) await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
}

/** Empties every app table. Test databases only. */
export async function truncateAll(url: string): Promise<void> {
  if (!/\/whiteboard_(test|e2e)$/.test(url)) throw new Error(`refusing to truncate ${url}`);
  await query(url, 'truncate users, boards, board_members, board_ops, board_snapshots cascade');
}

export async function query<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}
