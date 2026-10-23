import { buildApp } from './app';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';

const { app } = buildApp();

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Graceful shutdown (flush, snapshot, close with 1012) arrives in milestone 8.
    void app.close().then(() => process.exit(0));
  });
}
