import { CLOSE, TRY_AGAIN_LATER, parseClientMessage } from '@whiteboard/shared';
import type { Op, Role, ServerMessage } from '@whiteboard/shared';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { Metrics } from '../metrics';
import type { UserLimits } from './rateLimit';
import { TokenBucket } from './rateLimit';
import { SequencingUnavailable } from './Room';
import type { Peer, Room } from './Room';
import type { RoomManager } from './RoomManager';

/** Who this socket belongs to: established during the HTTP upgrade, never sent by the client. */
export interface SocketIdentity {
  boardId: string;
  userId: string;
  /** Display name, shown next to this user's cursor and in online lists. */
  name: string;
  role: Role;
}

export interface ConnectionDeps {
  /** This connection's id: also its presence peerId. */
  connId: string;
  rooms: RoomManager;
  /** Already bound to this connection's connId, userId and boardId. */
  log: FastifyBaseLogger;
  limits: UserLimits;
  msgsPerSec: number;
  msgsBurst: number;
  metrics: Metrics;
}

/**
 * Ops waiting for this user's rate budget, per socket. A client that keeps sending faster
 * than the limit grows this backlog; past it, the socket is closed (system-design.md, "Sizes
 * and limits": "throttled, then disconnected"). Our own client never gets near it: it keeps
 * at most a few hundred ops in flight.
 */
const MAX_QUEUED_OPS = 3000;

/**
 * One socket's lifecycle: it must send `hello` for the board named in its URL first, then
 * `ops` batches. Every message is parsed with the shared Zod schemas; anything malformed, or
 * a message flood, gets an `error` and the socket is closed with 1008.
 */
export function handleConnection(socket: WebSocket, who: SocketIdentity, deps: ConnectionDeps): void {
  const { boardId } = who;
  const { rooms, log, limits, metrics } = deps;
  const peer: Peer = {
    peerId: deps.connId,
    userId: who.userId,
    name: who.name,
    role: who.role,
    lastSeen: performance.now(),
    send: (msg) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
    close: (code, reason) => socket.close(code, reason),
    terminate: () => {
      log.info('no heartbeat: terminating');
      socket.terminate();
    },
  };
  const messages = new TokenBucket(deps.msgsPerSec, deps.msgsBurst);
  let room: Room | null = null;
  let joining = false;
  let closed = false;
  let queuedOps = 0;
  /** Op batches run strictly in arrival order, each after its rate-limit wait. */
  let chain: Promise<void> = Promise.resolve();

  metrics.wsConnections.inc();
  log.info({ role: who.role }, 'socket opened');

  const fail = (code: string, message: string) => {
    log.warn({ code }, `closing socket: ${message}`);
    const msg: ServerMessage = { t: 'error', code, message };
    peer.send(msg);
    socket.close(CLOSE.policyViolation, code);
  };

  const enqueueOps = (r: Room, ops: Op[]) => {
    queuedOps += ops.length;
    if (queuedOps > MAX_QUEUED_OPS) {
      metrics.wsRateLimitDisconnects.inc();
      return fail('rate_limited', 'sending ops faster than the rate limit allows');
    }
    chain = chain
      .then(() => limits.waitForOps(peer.userId, ops.length, () => metrics.wsThrottled.inc()))
      .then(async () => {
        queuedOps -= ops.length;
        if (closed) return;
        // Wait until this batch is applied (seqs reserved, delivered), so the next batch from
        // this socket applies after it; but not for its commit: the ack follows on its own.
        const { acked } = await r.receive(peer, ops);
        acked.catch((err: unknown) => {
          // No ack was sent, so the client keeps these ops pending and will resend them.
          log.error({ err }, 'failed to ack op batch');
        });
      })
      .catch((err: unknown) => {
        if (err instanceof SequencingUnavailable) {
          // Nothing was applied. Closing (not final) makes the client reconnect with backoff
          // and resend; by then Redis is hopefully back.
          log.warn({ err: { message: (err.cause as Error | undefined)?.message } }, 'cannot sequence ops (Redis): closing so the client retries');
          socket.close(TRY_AGAIN_LATER, 'try_again_later');
          return;
        }
        log.error({ err }, 'op queue failed');
      });
  };

  socket.on('message', (data: RawData, isBinary: boolean) => {
    peer.lastSeen = performance.now(); // any message counts as a heartbeat
    if (messages.take(1) > 0) {
      metrics.wsRateLimitDisconnects.inc();
      return fail('rate_limited', 'too many messages');
    }
    if (isBinary) return fail('bad_message', 'binary messages are not supported');
    const parsed = parseClientMessage(rawToString(data));
    if (!parsed.ok) return fail('bad_message', parsed.error);
    const msg = parsed.msg;

    switch (msg.t) {
      case 'hello':
        if (room || joining) return fail('bad_message', 'hello sent twice');
        if (msg.boardId !== boardId) return fail('bad_message', 'hello is for a different board than the URL');
        joining = true;
        // A client that has the board up to lastSeq gets only the ops after it (if the room
        // still has them all); otherwise the full snapshot.
        rooms
          .join(boardId, peer, msg.lastSeq)
          .then((r) => {
            room = r;
            // The socket may have closed while the board was loading.
            if (closed) rooms.leave(r, peer);
          })
          .catch((err: unknown) => {
            log.error({ err }, 'failed to load board');
            fail('load_failed', 'could not load the board');
          });
        return;
      case 'ops':
        if (!room) return fail('hello_first', 'send hello and wait for welcome before ops');
        return enqueueOps(room, msg.ops);
      case 'cursor':
      case 'select':
      case 'typing':
        // Presence before the room is ready has nowhere to go; the next update will.
        if (!room) return;
        metrics.presenceMessages.inc({ type: msg.t });
        room.relayPresence(peer, msg);
        return;
      case 'ping':
        // lastSeen was refreshed above; the pong lets the client tell a dead connection from a quiet one.
        peer.send({ t: 'pong' });
        return;
    }
  });

  socket.on('close', (code) => {
    closed = true;
    metrics.wsConnections.dec();
    limits.close(peer.userId, deps.connId);
    if (room) rooms.leave(room, peer);
    log.info({ code }, 'socket closed');
  });
  socket.on('error', (err) => log.warn({ err }, 'socket error'));
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
