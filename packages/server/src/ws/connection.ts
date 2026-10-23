import { randomUUID } from 'node:crypto';
import { parseClientMessage } from '@whiteboard/shared';
import type { ServerMessage } from '@whiteboard/shared';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { Peer, Room } from './Room';
import type { RoomManager } from './RoomManager';

/**
 * One socket's lifecycle: it must send `hello` for the board named in its URL first, then
 * `ops` batches. Every message is parsed with the shared Zod schemas; anything malformed gets
 * an `error` and the socket is closed (system-design.md, "Op pipeline" step 1).
 *
 * Milestone 4 has no auth yet: each socket gets an anonymous userId and the editor role.
 * Milestone 5 takes both from the JWT cookie, checked during the HTTP upgrade.
 */
export function handleConnection(socket: WebSocket, boardId: string, rooms: RoomManager, log: FastifyBaseLogger): void {
  const peer: Peer = {
    userId: `anon-${randomUUID().slice(0, 8)}`,
    role: 'editor',
    send: (msg) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
  };
  let room: Room | null = null;

  const fail = (code: string, message: string) => {
    const msg: ServerMessage = { t: 'error', code, message };
    peer.send(msg);
    socket.close(1008, code); // 1008 = policy violation
  };

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return fail('bad_message', 'binary messages are not supported');
    const parsed = parseClientMessage(rawToString(data));
    if (!parsed.ok) return fail('bad_message', parsed.error);
    const msg = parsed.msg;

    switch (msg.t) {
      case 'hello':
        if (room) return fail('bad_message', 'hello sent twice');
        if (msg.boardId !== boardId) return fail('bad_message', 'hello is for a different board than the URL');
        room = rooms.get(boardId);
        // lastSeq catch-up arrives with reconnect (milestone 7); for now every join gets the snapshot.
        peer.send(room.join(peer));
        return;
      case 'ops':
        if (!room) return fail('hello_first', 'send hello before ops');
        room.handleOps(peer, msg.ops).catch((err: unknown) => {
          // No ack was sent, so the client keeps these ops pending and will resend them.
          log.error({ err, boardId }, 'failed to process op batch');
        });
        return;
      case 'ping':
        return; // heartbeats and presence: milestone 6
    }
  });

  socket.on('close', () => room?.leave(peer));
  socket.on('error', (err) => log.warn({ err, boardId }, 'socket error'));
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
