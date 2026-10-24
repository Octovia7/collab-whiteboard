import type { Role } from '@whiteboard/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { BoardEvent, PresenceEvent } from './Room';

/** Everything servers tell each other about a board on `board:{id}`. */
export type BoardMessage =
  | BoardEvent
  /** A member's role changed over REST: their sockets on every server switch now. */
  | { type: 'role'; userId: string; role: Role }
  /** A member was removed: their sockets on every server close with 4003. */
  | { type: 'removed'; userId: string }
  /** The board was deleted: every socket closes with 4004. */
  | { type: 'deleted' };

interface Envelope {
  /** Who published it: a server ignores its own messages (it already handled them locally). */
  from: string;
  msg: unknown;
}

interface BoardHandlers {
  board(msg: BoardMessage): void;
  presence(msg: PresenceEvent): void;
}

const SESSIONS = 'sessions';

/**
 * Redis pub/sub between servers (system-design.md, "Server design"): `board:{id}` for ops,
 * skips and membership changes, `presence:{id}` for cursors and the online list, `sessions`
 * for logouts. Publishing uses the shared connection; subscribing needs a connection of its
 * own (a subscribed Redis connection can't run other commands).
 *
 * Pub/sub is fire-and-forget: a message lost in a Redis blip is a gap the receiving rooms fill
 * from Postgres (ops), or simply replaced by the next update (presence).
 */
export class RedisBus {
  /** Fault injection for tests: return true to drop an incoming message as if Redis lost it. */
  readonly faults: { dropIncoming: ((channel: string, msg: unknown) => boolean) | null } = { dropIncoming: null };
  private readonly sub: Redis;
  private readonly boards = new Map<string, BoardHandlers>();
  private readonly revokedListeners = new Set<(jti: string) => void>();
  private lastPublishWarn = 0;

  constructor(
    private readonly pub: Redis,
    readonly serverId: string,
    private readonly log: FastifyBaseLogger,
  ) {
    // Same options as the shared connection. ioredis resubscribes by itself after reconnecting.
    this.sub = pub.duplicate();
    this.sub.on('error', () => {}); // reported by the shared connection's handler; don't crash
    this.sub.on('message', (channel: string, raw: string) => this.dispatch(channel, raw));
    this.sub.subscribe(SESSIONS).catch((err: unknown) => log.error({ err }, 'could not subscribe to sessions'));
  }

  /**
   * Resolves once Redis confirms the subscription: a room subscribes before it reads Postgres,
   * so no op can be published between its read and its subscription.
   */
  async subscribeBoard(boardId: string, handlers: BoardHandlers): Promise<void> {
    this.boards.set(boardId, handlers);
    await this.sub.subscribe(`board:${boardId}`, `presence:${boardId}`);
  }

  async unsubscribeBoard(boardId: string): Promise<void> {
    this.boards.delete(boardId);
    await this.sub.unsubscribe(`board:${boardId}`, `presence:${boardId}`).catch(() => {});
  }

  publishBoard(boardId: string, msg: BoardMessage): void {
    this.publish(`board:${boardId}`, msg);
  }

  publishPresence(boardId: string, msg: PresenceEvent): void {
    this.publish(`presence:${boardId}`, msg);
  }

  /** Logout: every server closes the sockets of this session. Awaited, so logout knows it went out. */
  async publishSessionRevoked(jti: string): Promise<void> {
    await this.pub.publish(SESSIONS, JSON.stringify({ from: this.serverId, msg: { jti } } satisfies Envelope));
  }

  /** Called for every revoked session, including ones this server revoked itself. */
  onSessionRevoked(fn: (jti: string) => void): () => void {
    this.revokedListeners.add(fn);
    return () => this.revokedListeners.delete(fn);
  }

  close(): void {
    this.sub.disconnect();
  }

  private publish(channel: string, msg: unknown): void {
    this.pub.publish(channel, JSON.stringify({ from: this.serverId, msg } satisfies Envelope)).catch((err: unknown) => {
      const now = Date.now();
      if (now - this.lastPublishWarn < 10_000) return;
      this.lastPublishWarn = now;
      // Other servers fill lost ops from Postgres; lost presence is replaced by the next update.
      this.log.warn({ err: { message: (err as Error).message }, channel }, 'redis publish failed');
    });
  }

  private dispatch(channel: string, raw: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      this.log.warn({ channel }, 'ignoring malformed pub/sub message');
      return;
    }
    if (channel === SESSIONS) {
      const jti = (env.msg as { jti?: unknown }).jti;
      if (typeof jti === 'string') for (const fn of this.revokedListeners) fn(jti);
      return;
    }
    if (env.from === this.serverId) return;
    if (this.faults.dropIncoming?.(channel, env.msg)) return;
    const sep = channel.indexOf(':');
    const kind = channel.slice(0, sep);
    const handlers = this.boards.get(channel.slice(sep + 1));
    if (!handlers) return;
    try {
      if (kind === 'board') handlers.board(env.msg as BoardMessage);
      else if (kind === 'presence') handlers.presence(env.msg as PresenceEvent);
    } catch (err) {
      this.log.error({ err, channel }, 'failed to handle pub/sub message');
    }
  }
}
