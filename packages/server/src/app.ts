import { LIMITS, boardIdSchema } from '@whiteboard/shared';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import { MemoryOpStore } from './persistence/OpStore';
import type { OpStore } from './persistence/OpStore';
import { handleConnection } from './ws/connection';
import { RoomManager } from './ws/RoomManager';

export interface AppOptions {
  opStore?: OpStore;
  logger?: boolean;
}

/**
 * Fastify for REST plus a raw `ws` server sharing its HTTP server on /ws. Handling the
 * upgrade ourselves (noServer) is what lets milestone 5 check the JWT cookie and the user's
 * board role before a socket is ever accepted.
 */
export function buildApp(options: AppOptions = {}): { app: FastifyInstance; rooms: RoomManager } {
  const app = Fastify({ logger: options.logger ?? true });
  const rooms = new RoomManager(options.opStore ?? new MemoryOpStore());
  // maxPayload enforces the 256 KB message limit before any JSON parsing happens.
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });

  app.get('/api/health', async () => ({ ok: true }));

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const board = boardIdSchema.safeParse(url.searchParams.get('board'));
    if (url.pathname !== '/ws' || !board.success) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, board.data, rooms, app.log));
  });

  app.addHook('onClose', async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });

  return { app, rooms };
}
