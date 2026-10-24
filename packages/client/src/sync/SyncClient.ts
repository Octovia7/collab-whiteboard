import { CLOSE, FINAL_CLOSE_CODES, LIMITS, PRESENCE, SERVICE_RESTART, parseServerMessage } from '@whiteboard/shared';
import type { ClientMessage, Op, Role, ServerMessage } from '@whiteboard/shared';
import { Emitter } from '../lib/Emitter';
import type { BoardStore } from '../store/BoardStore';
import type { Presence } from '../store/Presence';
import { enqueueCoalesced } from './coalesce';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'disconnected';

/** Reconnect delays (system-design.md, "SyncClient"): 0.5 s, 1 s, 2 s, ... capped at 10 s. */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10_000];

/**
 * Flow control: at most this many ops sent but not yet acked. More wait in the outbox and go
 * out as acks arrive, so a big paste or a long offline queue never trips the server's per-user
 * rate limit (system-design.md: 200 ops/s, bursts of 1,000).
 */
const MAX_IN_FLIGHT = 500;

export interface SyncOptions {
  /** Full WebSocket URL including ?board=. */
  url: string;
  boardId: string;
  /** How long local ops collect before being sent as one batch. */
  flushMs?: number;
  /** Send a ping after this long with nothing else sent (default PRESENCE.heartbeatMs, 5 s). */
  heartbeatMs?: number;
  /** Injected for tests; defaults to the global WebSocket (browser, or Node 22). */
  WebSocketImpl?: typeof WebSocket;
  /** Where other people's cursors and selections go. */
  presence?: Presence;
  /** Gets every unacked op whenever that set changes, to survive a reload (OfflineQueue). */
  queue?: { save(ops: readonly Op[]): void };
}

/**
 * Keeps the local BoardStore in sync with the server (algorithms.md §6):
 * - local edits arrive via the store's `submit` event (they were already applied: optimistic),
 *   wait in the outbox for up to `flushMs`, and are sent in batches;
 * - sent ops stay in `pending` until the server acks them, i.e. until they are durable;
 * - ops from other users go into the store with `receive`, where LWW decides;
 * - a reject rolls the shape back to the server's registers.
 * - a dropped socket is reopened with backoff; the welcome brings what we missed (or a full
 *   snapshot) and every unacked op is resent, which is safe because the server dedupes by opId;
 * - unacked ops are also handed to the offline queue, so a reload or closed tab loses nothing.
 */
export class SyncClient {
  readonly events = new Emitter<{ status: ConnectionStatus; welcome: undefined; role: Role }>();
  private socket: WebSocket | null = null;
  /** Submitted locally, not yet sent. */
  private outbox: Op[] = [];
  /** Sent, waiting for an ack; insertion order = send order. */
  private readonly pending = new Map<string, Op>();
  private lastSeq = 0;
  private welcomed = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentStatus: ConnectionStatus = 'connecting';
  private offSubmit: (() => void) | null = null;
  private readonly flushMs: number;
  private currentRole: Role | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Why the server closed us for good (board deleted, removed), if it did. */
  private finalReason: string | null = null;
  // Presence out: latest cursor waiting for its 50 ms slot, last selection sent, heartbeat clock.
  private pendingCursor: { x: number; y: number } | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCursorSent = 0;
  private lastSelection = '';
  private typingIn: string | null = null;
  /** performance.now() of the last message from the server (dead-connection detection). */
  private lastReceivedAt = 0;
  private offlineListeners: (() => void) | null = null;
  /** How the board arrived on the last welcome: a full snapshot, or catch-up ops. */
  lastWelcome: { kind: 'snapshot' | 'ops'; ops: number } | null = null;
  private lastSentAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: BoardStore,
    private readonly options: SyncOptions,
  ) {
    this.flushMs = options.flushMs ?? 50;
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  /** Our role on this board, from welcome and live `role` messages; null before welcome. */
  get role(): Role | null {
    return this.currentRole;
  }

  get closeReason(): string | null {
    return this.finalReason;
  }

  /** Ops not yet acknowledged as durable (queued or in flight). */
  get unackedCount(): number {
    return this.outbox.length + this.pending.size;
  }

  /** Highest server seq seen; sent in `hello` to catch up after a drop. */
  get seq(): number {
    return this.lastSeq;
  }

  start(): void {
    this.stopped = false;
    // Heartbeat (algorithms.md §8): if nothing else went out for a while, say we're still here,
    // so the server doesn't drop us as a closed laptop lid.
    const heartbeatMs = this.options.heartbeatMs ?? PRESENCE.heartbeatMs;
    this.heartbeat = setInterval(() => {
      if (!this.welcomed) return;
      const now = performance.now();
      // The server answers every ping with a pong. Nothing at all for three heartbeats means
      // the connection is dead without having closed (sleep, a dropped NAT mapping): close it
      // ourselves and reconnect, instead of typing into a socket that goes nowhere.
      if (now - this.lastReceivedAt > heartbeatMs * 3) {
        this.socket?.close();
        return;
      }
      // Ping when we've been quiet, and also when the server has: a client that only sends
      // (cursor moves, with nobody else on the board) would otherwise never hear anything back.
      if (now - this.lastSentAt >= heartbeatMs || now - this.lastReceivedAt >= heartbeatMs) this.send({ t: 'ping' });
    }, heartbeatMs / 2);
    this.watchNetwork();
    this.offSubmit = this.store.events.on('submit', ({ ops }) => {
      for (const op of ops) enqueueCoalesced(this.outbox, op);
      this.persist();
      this.scheduleFlush();
    });
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.offlineListeners?.();
    this.offlineListeners = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.offSubmit?.();
    this.offSubmit = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /**
   * My pointer moved (world coordinates). Sent at most every 50 ms; the latest position always
   * goes out, so a cursor that stops between ticks still lands where it stopped. Dropped while
   * disconnected: presence is ephemeral, the next move after reconnecting replaces it.
   */
  sendCursor(x: number, y: number): void {
    this.pendingCursor = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    if (this.cursorTimer) return;
    const wait = Math.max(0, PRESENCE.cursorIntervalMs - (performance.now() - this.lastCursorSent));
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      const c = this.pendingCursor;
      this.pendingCursor = null;
      if (!c || !this.welcomed) return;
      this.lastCursorSent = performance.now();
      this.send({ t: 'cursor', x: c.x, y: c.y });
    }, wait);
  }

  /** My selection changed; sent only when it actually differs from the last one sent. */
  sendSelection(ids: readonly string[]): void {
    const key = [...ids].sort().join(',');
    if (key === this.lastSelection) return;
    this.lastSelection = key;
    if (this.welcomed) this.send({ t: 'select', ids: [...ids].slice(0, LIMITS.maxSelectedIds) });
  }

  /** I started (id) or stopped (null) editing a note's text: other tabs show it as being typed in. */
  sendTyping(id: string | null): void {
    if (id === this.typingIn) return;
    this.typingIn = id;
    if (this.welcomed) this.send({ t: 'typing', id });
  }

  /**
   * Ops a previous page load made but never got acked (from the offline queue). Our clock
   * observes their stamps first: they may have been made by an earlier clientId with a later
   * time than anything we've seen, and our next edit must still win over them. Then they're
   * applied locally and queued like any unacked op; a snapshot welcome re-applies them on top.
   */
  restore(ops: readonly Op[]): void {
    if (ops.length === 0) return;
    for (const op of ops) this.store.clock.observe(op.stamp);
    this.store.reapply([...ops]);
    for (const op of ops) enqueueCoalesced(this.outbox, op);
    this.persist();
    this.scheduleFlush();
  }

  /** Sends everything queued now instead of waiting for the timer. */
  flush(): void {
    const socket = this.socket;
    if (!this.welcomed || !socket || socket.readyState !== socket.OPEN) return;
    while (this.outbox.length > 0 && this.pending.size < MAX_IN_FLIGHT) {
      const room = MAX_IN_FLIGHT - this.pending.size;
      const batch = this.outbox.splice(0, Math.min(LIMITS.maxOpsPerBatch, room));
      for (const op of batch) this.pending.set(op.opId, op);
      this.send({ t: 'ops', ops: batch });
    }
  }

  private open(): void {
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const socket = new Impl(this.options.url);
    this.socket = socket;
    if (this.attempts === 0) this.setStatus('connecting');
    socket.onopen = () => this.send({ t: 'hello', boardId: this.options.boardId, lastSeq: this.lastSeq });
    // A failed connect or a broken socket always ends in `close`, which handles the retry.
    // The handler must exist anyway: Node's ws throws an 'error' event nobody listens to.
    socket.onerror = () => {};
    socket.onmessage = (e: MessageEvent) => {
      // A socket we've stopped or replaced can still deliver a few messages while closing.
      if (this.socket !== socket || typeof e.data !== 'string') return;
      this.lastReceivedAt = performance.now();
      const parsed = parseServerMessage(e.data);
      if (!parsed.ok) {
        console.error(`sync: ignoring invalid server message (${parsed.error})`);
        return;
      }
      this.handle(parsed.msg);
    };
    socket.onclose = (e: CloseEvent) => {
      if (this.socket !== socket || this.stopped) return; // stopped, or replaced by a newer socket
      this.welcomed = false;
      this.socket = null;
      this.options.presence?.clear();
      if (FINAL_CLOSE_CODES.includes(e.code)) {
        // The server ended this for good (board deleted, removed, protocol violation).
        this.finalReason = e.reason || 'closed';
        // No board, or no longer a member: these edits can never be sent, so don't keep them.
        // After a policy violation (1008) they stay saved; a reload sends them.
        if (e.code === CLOSE.removedFromBoard || e.code === CLOSE.boardDeleted) {
          this.outbox = [];
          this.pending.clear();
          this.persist();
        }
        this.setStatus('disconnected');
        return;
      }
      // Anything else (network drop, server restart): keep every unacked op and try again.
      if (this.isOffline()) {
        // No network at all: wait for the browser's `online` event instead of retrying blind.
        this.setStatus('offline');
        return;
      }
      this.setStatus('reconnecting');
      // A graceful restart (1012) means "come straight back"; jitter spreads a whole board's
      // worth of clients over half a second instead of all at once.
      const delay =
        e.code === SERVICE_RESTART && this.attempts === 0
          ? 100 + Math.random() * 500
          : (BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)] as number);
      this.attempts++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.stopped) this.open();
      }, delay);
    };
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        // Ops sent on an earlier socket and never acked go out again, ahead of newer ones.
        // Duplicates are harmless: the server acks a known opId without applying it twice.
        this.outbox = [...this.pending.values(), ...this.outbox];
        this.pending.clear();
        if (msg.ops) {
          // Catch-up (algorithms.md §12b): the server sent only what we missed since lastSeq.
          // Our board, including our own unacked edits, stays as it is; LWW merges the rest.
          this.store.receive(msg.ops);
          this.lastWelcome = { kind: 'ops', ops: msg.ops.length };
        } else {
          // A full snapshot (first join, or too far behind): it replaces our board, then our
          // unacked edits go back on top. They're still ours and reach the server shortly.
          this.store.loadSnapshot(msg.snapshot);
          this.store.reapply(this.outbox);
          this.lastWelcome = { kind: 'snapshot', ops: 0 };
        }
        this.lastSeq = msg.seq;
        this.welcomed = true;
        this.attempts = 0;
        this.setRole(msg.role);
        this.options.presence?.reset(msg.you, msg.peers);
        // Re-announce my selection to the (possibly new) room.
        if (this.lastSelection) this.send({ t: 'select', ids: this.lastSelection.split(',') });
        if (this.typingIn) this.send({ t: 'typing', id: this.typingIn });
        this.setStatus('connected');
        this.events.emit('welcome', undefined);
        this.flush();
        return;
      }
      case 'ops':
        this.store.receive(msg.ops);
        this.lastSeq = Math.max(this.lastSeq, msg.seq);
        return;
      case 'ack':
        for (const id of msg.opIds) this.pending.delete(id);
        this.persist();
        this.lastSeq = Math.max(this.lastSeq, msg.seq);
        this.flush(); // room in the in-flight window again
        return;
      case 'reject': {
        const op = this.pending.get(msg.opId);
        this.pending.delete(msg.opId);
        this.persist();
        const shapeId = op ? (op.kind === 'create' ? op.shape.id : op.id) : msg.shape?.id;
        console.warn(`sync: op ${msg.opId} rejected (${msg.reason})`);
        if (!shapeId) return;
        this.store.rollback(shapeId, msg.shape);
        // The server's shape predates our other unacked edits to it (sent later in the same
        // batch, or not sent yet). Put them back on top, as after loading a snapshot; if any
        // of them is also rejected, its own reject rolls it back in turn.
        const targets = (o: Op) => (o.kind === 'create' ? o.shape.id : o.id) === shapeId;
        this.store.reapply([...this.pending.values(), ...this.outbox].filter(targets));
        return;
      }
      case 'role':
        this.setRole(msg.role);
        return;
      case 'peer-join':
        this.options.presence?.join(msg.peer);
        return;
      case 'peer-leave':
        this.options.presence?.leave(msg.peerId);
        return;
      case 'cursor':
        this.options.presence?.cursor(msg.peerId, msg.x, msg.y);
        return;
      case 'select':
        this.options.presence?.select(msg.peerId, msg.ids);
        return;
      case 'typing':
        this.options.presence?.typing(msg.peerId, msg.id);
        return;
      case 'pong':
        return; // receipt alone (lastReceivedAt) is the point
      case 'error':
        console.error(`sync: server error ${msg.code}: ${msg.message}`);
        return; // the server closes the socket next; onclose updates the status
    }
  }

  private isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /**
   * Browser network events: going offline closes the socket right away (instead of waiting for
   * a timeout) so edits pile up as pending; coming back online reconnects immediately, and the
   * hello's lastSeq gets us caught up. Not in Node (tests), which has no such events.
   */
  private watchNetwork(): void {
    if (typeof window === 'undefined' || this.offlineListeners) return;
    const offline = () => {
      this.setStatus('offline');
      this.socket?.close();
    };
    const online = () => {
      if (this.stopped || this.welcomed || (this.socket && this.socket.readyState === this.socket.CONNECTING)) return;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.attempts = 0;
      this.open();
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    this.offlineListeners = () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }

  private persist(): void {
    this.options.queue?.save([...this.pending.values(), ...this.outbox]);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushMs);
  }

  private send(msg: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(msg));
    this.lastSentAt = performance.now();
  }

  private setRole(role: Role): void {
    if (role === this.currentRole) return;
    this.currentRole = role;
    this.events.emit('role', role);
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.events.emit('status', status);
  }
}
