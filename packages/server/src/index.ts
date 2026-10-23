import { buildApp } from './app';
import { loadConfig } from './config';
import { runMigrations } from './db/client';

const config = loadConfig();
const { app, database } = await buildApp(config);

try {
  // Apply pending migrations on start, so a fresh database just works in development.
  await runMigrations(database.db);
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Flushes the op log and snapshots loaded rooms (via onClose). Closing sockets with 1012
    // so clients reconnect immediately arrives in milestone 8.
    void app.close().then(() => process.exit(0));
  });
}
