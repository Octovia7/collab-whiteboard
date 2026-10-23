import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import { LIMITS } from '@whiteboard/shared';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Config } from './config';
import { connect } from './db/client';
import type { Database } from './db/client';
import { SESSION_COOKIE, registerAuthRoutes } from './http/auth';
import { registerBoardRoutes } from './http/boards';
import { OpWriter } from './persistence/OpWriter';
import { Repo } from './persistence/repo';
import { Snapshotter } from './persistence/Snapshotter';
import { handleConnection } from './ws/connection';
import type { SocketIdentity } from './ws/connection';
import { RoomManager } from './ws/RoomManager';

export interface App {
  app: FastifyInstance;
  rooms: RoomManager;
  repo: Repo;
  database: Database;
}

const uuid = z.string().uuid();

type UpgradeResult = { ok: false; status: number; text: string } | ({ ok: true } & SocketIdentity);

/**
 * Fastify for REST plus a raw `ws` server sharing its HTTP server on /ws. Handling the upgrade
 * ourselves (noServer) lets us authenticate before a socket exists: origin, session cookie and
 * board role are all checked during the HTTP upgrade, and failures get a plain HTTP error.
 */
export async function buildApp(config: Config): Promise<App> {
  const app = Fastify({ logger: config.logger });
  const database = connect(config.databaseUrl);
  const repo = new Repo(database.db);
  const writer = new OpWriter(repo, app.log, config.faults.commitDelayMs);
  const snapshotter = new Snapshotter(repo, writer, app.log, config.snapshotEveryOps, config.snapshotEveryMs);
  const rooms = new RoomManager({
    repo,
    store: writer,
    snapshotter,
    log: app.log,
    unloadAfterMs: config.roomUnloadMs,
    ackDelayMs: config.faults.ackDelayMs,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyJwt, { secret: config.jwtSecret, cookie: { cookieName: SESSION_COOKIE, signed: false } });

  app.get('/api/health', async (_req, reply) => {
    try {
      await database.pool.query('select 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
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
    const url = new URL(req.url ?? '/', 'http://localhost');
    const board = uuid.safeParse(url.searchParams.get('board'));
    if (url.pathname !== '/ws' || !board.success) return { ok: false, status: 400, text: 'Bad Request' };
    // Browsers send cookies on cross-site WebSocket upgrades too, so without this any site the
    // user visits could open a socket as them (cross-site WebSocket hijacking).
    if (!config.allowedOrigins.includes(req.headers.origin ?? '')) return { ok: false, status: 403, text: 'Forbidden' };
    const token = app.parseCookie(req.headers.cookie ?? '')[SESSION_COOKIE];
    let userId: string;
    try {
      userId = app.jwt.verify<{ sub: string }>(token ?? '').sub;
    } catch {
      return { ok: false, status: 401, text: 'Unauthorized' };
    }
    const role = await repo.getRole(board.data, userId);
    if (!role) return { ok: false, status: 403, text: 'Forbidden' };
    return { ok: true, boardId: board.data, userId, role };
  };

  app.server.on('upgrade', (req, socket, head) => {
    authorizeUpgrade(req)
      .then((result) => {
        if (!result.ok) return refuse(socket, result.status, result.text);
        const { boardId, userId, role } = result;
        wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, { boardId, userId, role }, rooms, app.log));
      })
      .catch((err: unknown) => {
        app.log.error({ err }, 'upgrade failed');
        refuse(socket, 500, 'Internal Server Error');
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
  });

  return { app, rooms, repo, database };
}
