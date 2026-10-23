import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import { LIMITS, SERVICE_RESTART } from '@whiteboard/shared';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex, Writable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Config } from './config';
import { connect } from './db/client';
import type { Database } from './db/client';
import { AppError, isTransient } from './errors';
import { SESSION_COOKIE, registerAuthRoutes } from './http/auth';
import { registerBoardRoutes } from './http/boards';
import { createMetrics } from './metrics';
import type { Metrics } from './metrics';
import { OpWriter } from './persistence/OpWriter';
import { Repo } from './persistence/repo';
import { Snapshotter } from './persistence/Snapshotter';
import { connectRedis } from './redis';
import { handleConnection } from './ws/connection';
import type { SocketIdentity } from './ws/connection';
import { UserLimits } from './ws/rateLimit';
import { RoomManager } from './ws/RoomManager';

export interface App {
  app: FastifyInstance;
  rooms: RoomManager;
  repo: Repo;
  database: Database;
  redis: Redis;
  metrics: Metrics;
  /** Graceful shutdown: flush, close sockets with 1012, snapshot rooms, close everything. */
  shutdown(): Promise<void>;
}

const uuid = z.string().uuid();

type UpgradeResult = { ok: false; status: number; text: string; reason: string } | ({ ok: true } & SocketIdentity);

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

/** Never-logged fields: credentials and session tokens, wherever they appear in a log object. */
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.cookie',
];

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);

/**
 * Fastify for REST plus a raw `ws` server sharing its HTTP server on /ws. Handling the upgrade
 * ourselves (noServer) lets us authenticate before a socket exists: origin, session cookie,
 * board role and the per-user socket cap are all checked during the HTTP upgrade, and
 * failures get a plain HTTP error.
 */
export async function buildApp(config: Config, options: { logStream?: Writable } = {}): Promise<App> {
  const app = Fastify({
    logger: { level: config.logLevel, redact: { paths: REDACT, censor: '[redacted]' }, ...(options.logStream ? { stream: options.logStream } : {}) },
    // A request id on every log line of a request, echoed back to the client (and taken from
    // the proxy if it already assigned one).
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024, // REST bodies are tiny; board content goes over the WebSocket
  });
  const metrics = createMetrics();
  const database = connect(config.databaseUrl);
  const redis = connectRedis(config.redisUrl, app.log);
  const repo = new Repo(database.db);
  const writer = new OpWriter(repo, app.log, config.faults.commitDelayMs);
  const snapshotter = new Snapshotter(repo, writer, app.log, config.snapshotEveryOps, config.snapshotEveryMs, metrics);
  const rooms = new RoomManager({
    repo,
    store: writer,
    snapshotter,
    log: app.log,
    unloadAfterMs: config.roomUnloadMs,
    ackDelayMs: config.faults.ackDelayMs,
    metrics,
    presenceTimeoutMs: config.presence.timeoutMs,
    presenceSweepMs: config.presence.sweepMs,
  });
  const limits = new UserLimits(config.ws.opsPerSec, config.ws.opsBurst, config.ws.maxSocketsPerUser);
  let shuttingDown = false;

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(fastifyHelmet, {
    // The API only serves JSON; the client's CSP is set by the static file server (nginx).
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(fastifyCors, {
    origin: (origin, cb) => cb(null, origin === undefined || config.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });
  await app.register(fastifyCookie);
  await app.register(fastifyJwt, { secret: config.jwtSecret, cookie: { cookieName: SESSION_COOKIE, signed: false } });
  await app.register(fastifyRateLimit, {
    global: false, // only the routes that opt in (login, signup)
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: 'rate_limited', message: `retry in ${ctx.after}` }),
  });

  // Typed errors to proper responses. Unknown errors become a generic 500 (logged with the
  // request id); the client never sees internals.
  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code });
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: STATUS_CODES[status] ?? 'bad_request' });
    }
    if (isTransient(err)) {
      req.log.warn({ err }, 'dependency unavailable');
      return reply.code(503).send({ error: 'service_unavailable' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  /** Liveness: the process is up and serving. */
  app.get('/healthz', async () => ({ ok: true }));

  /** Readiness: Postgres and Redis reachable, and not shutting down. Load balancers route on this. */
  app.get('/readyz', async (_req, reply) => {
    if (shuttingDown) return reply.code(503).send({ ok: false, shuttingDown: true });
    const [postgres, redisOk] = await Promise.all([
      withTimeout(database.pool.query('select 1'), 2_000).then(
        () => true,
        () => false,
      ),
      withTimeout(redis.ping(), 2_000).then(
        (r) => r === 'PONG',
        () => false,
      ),
    ]);
    const ok = postgres && redisOk;
    return reply.code(ok ? 200 : 503).send({ ok, postgres, redis: redisOk });
  });

  app.get('/metrics', async (req, reply) => {
    if (config.metricsToken && req.headers.authorization !== `Bearer ${config.metricsToken}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  registerAuthRoutes(app, repo, config);
  registerBoardRoutes(app, repo, rooms);

  // maxPayload enforces the 256 KB message limit before any JSON parsing happens.
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });

  const refuse = (socket: Duplex, status: number, text: string) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  const authorizeUpgrade = async (req: IncomingMessage): Promise<UpgradeResult> => {
    if (shuttingDown) return { ok: false, status: 503, text: 'Service Unavailable', reason: 'shutting_down' };
    const url = new URL(req.url ?? '/', 'http://localhost');
    const board = uuid.safeParse(url.searchParams.get('board'));
    if (url.pathname !== '/ws' || !board.success) return { ok: false, status: 400, text: 'Bad Request', reason: 'bad_url' };
    // Browsers send cookies on cross-site WebSocket upgrades too, so without this any site the
    // user visits could open a socket as them (cross-site WebSocket hijacking).
    if (!config.allowedOrigins.includes(req.headers.origin ?? '')) return { ok: false, status: 403, text: 'Forbidden', reason: 'origin' };
    const token = app.parseCookie(req.headers.cookie ?? '')[SESSION_COOKIE];
    let userId: string;
    try {
      userId = app.jwt.verify<{ sub: string }>(token ?? '').sub;
    } catch {
      return { ok: false, status: 401, text: 'Unauthorized', reason: 'no_session' };
    }
    const role = await repo.getRole(board.data, userId);
    if (!role) return { ok: false, status: 403, text: 'Forbidden', reason: 'not_a_member' };
    const user = await repo.findUserById(userId);
    if (!user) return { ok: false, status: 401, text: 'Unauthorized', reason: 'unknown_user' };
    return { ok: true, boardId: board.data, userId, name: user.name, role };
  };

  app.server.on('upgrade', (req, socket, head) => {
    const connId = randomUUID();
    const log = app.log.child({ connId });
    // Errors on the raw socket before the handshake completes (client went away) must not crash us.
    socket.on('error', (err) => log.debug({ err }, 'upgrade socket error'));
    authorizeUpgrade(req)
      .then((result) => {
        if (!result.ok) {
          log.info({ status: result.status, reason: result.reason }, 'upgrade refused');
          return refuse(socket, result.status, result.text);
        }
        const { boardId, userId, name, role } = result;
        if (!limits.open(userId)) {
          log.warn({ userId, boardId }, 'upgrade refused: too many sockets');
          return refuse(socket, 429, 'Too Many Requests');
        }
        wss.handleUpgrade(req, socket, head, (ws) =>
          handleConnection(ws, { boardId, userId, name, role }, {
            connId,
            rooms,
            log: log.child({ userId, boardId }),
            limits,
            msgsPerSec: config.ws.msgsPerSec,
            msgsBurst: config.ws.msgsBurst,
            metrics,
          }),
        );
      })
      .catch((err: unknown) => {
        log.error({ err }, 'upgrade failed');
        refuse(socket, isTransient(err) ? 503 : 500, isTransient(err) ? 'Service Unavailable' : 'Internal Server Error');
      });
  });

  // preClose runs before the HTTP server stops; open sockets would otherwise keep it waiting.
  app.addHook('preClose', async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
  app.addHook('onClose', async () => {
    await rooms.closeAll();
    await writer.close();
    await database.pool.end();
    redis.disconnect();
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true; // /readyz now fails and new upgrades get 503
    app.log.info('graceful shutdown: flushing writes');
    // 1. Commit what's buffered, so the acks for already-accepted ops go out.
    await writer.drain();
    // 2. Tell clients to come back right away (1012 = service restart): they reconnect to
    //    another instance, or to this one once restarted, and resend anything unacked.
    for (const client of wss.clients) client.close(SERVICE_RESTART, 'service_restart');
    // 3. Final snapshot of every loaded board, then stop listening and close Postgres/Redis.
    await rooms.closeAll();
    await app.close();
    app.log.info('graceful shutdown complete');
  };

  return { app, rooms, repo, database, redis, metrics, shutdown };
}
