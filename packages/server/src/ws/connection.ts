import { CLOSE, parseClientMessage } from '@whiteboard/shared';
import type { Role, ServerMessage } from '@whiteboard/shared';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { Peer, Room } from './Room';
import type { RoomManager } from './RoomManager';

/** Who this socket belongs to: established during the HTTP upgrade, never sent by the client. */
export interface SocketIdentity {
  boardId: string;
  userId: string;
  role: Role;
}

/**
 * One socket's lifecycle: it must send `hello` for the board named in its URL first, then
 * `ops` batches. Every message is parsed with the shared Zod schemas; anything malformed gets
 * an `error` and the socket is closed (system-design.md, "Op pipeline" step 1).
 */
export function handleConnection(socket: WebSocket, who: SocketIdentity, rooms: RoomManager, log: FastifyBaseLogger): void {
  const { boardId } = who;
  const peer: Peer = {
    userId: who.userId,
    role: who.role,
    send: (msg) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
    close: (code, reason) => socket.close(code, reason),
  };
  let room: Room | null = null;
  let joining = false;
  let closed = false;

  const fail = (code: string, message: string) => {
    const msg: ServerMessage = { t: 'error', code, message };
    peer.send(msg);
    socket.close(CLOSE.policyViolation, code);
  };

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return fail('bad_message', 'binary messages are not supported');
    const parsed = parseClientMessage(rawToString(data));
    if (!parsed.ok) return fail('bad_message', parsed.error);
    const msg = parsed.msg;

    switch (msg.t) {
      case 'hello':
        if (room || joining) return fail('bad_message', 'hello sent twice');
        if (msg.boardId !== boardId) return fail('bad_message', 'hello is for a different board than the URL');
        joining = true;
        // lastSeq catch-up arrives in milestone 7; for now every join gets the full snapshot.
        rooms
          .join(boardId, peer)
          .then((r) => {
            room = r;
            // The socket may have closed while the board was loading.
            if (closed) rooms.leave(r, peer);
          })
          .catch((err: unknown) => {
            log.error({ err, boardId }, 'failed to load board');
            fail('load_failed', 'could not load the board');
          });
        return;
      case 'ops':
        if (!room) return fail('hello_first', 'send hello and wait for welcome before ops');
        room.handleOps(peer, msg.ops).catch((err: unknown) => {
          // No ack was sent, so the client keeps these ops pending and will resend them.
          log.error({ err, boardId }, 'failed to process op batch');
        });
        return;
      case 'ping':
        return; // heartbeats and presence: milestone 6
    }
  });

  socket.on('close', () => {
    closed = true;
    if (room) rooms.leave(room, peer);
  });
  socket.on('error', (err) => log.warn({ err, boardId }, 'socket error'));
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
