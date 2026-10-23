import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import type { Config } from './config';
import { runMigrations } from './db/client';

/** Hard cap on graceful shutdown; orchestrators usually SIGKILL after 30 s. */
const SHUTDOWN_TIMEOUT_MS = 25_000;

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // Refuse to start on bad config, saying exactly what is wrong (never the values themselves).
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const { app, database, shutdown } = await buildApp(config);

const stop = (code: number) => {
  const timer = setTimeout(() => {
    app.log.error('graceful shutdown timed out; exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  shutdown().then(
    () => process.exit(code),
    (err: unknown) => {
      app.log.error({ err }, 'graceful shutdown failed');
      process.exit(1);
    },
  );
};

// A bug that slips past every handler: log it, shut down cleanly, and let the process
// supervisor restart us. Unacked ops are resent by clients, so nothing acked is lost.
process.on('unhandledRejection', (err) => {
  app.log.fatal({ err }, 'unhandled promise rejection');
  stop(1);
});
process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'uncaught exception');
  stop(1);
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'received signal');
    stop(0);
  });
}

try {
  // Migrations run on every deploy/start, serialized by an advisory lock across replicas.
  await runMigrations(database.pool, config.migrationsDir);
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
