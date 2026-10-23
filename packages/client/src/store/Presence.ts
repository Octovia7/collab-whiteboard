import type { PeerInfo } from '@whiteboard/shared';
import { Emitter } from '../lib/Emitter';

/** 10 distinguishable colors; a user always gets the same one (hash of their id). */
export const PEER_COLORS = ['#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#0c8599', '#d6336c', '#5f3dc4', '#66a80f', '#e8590c'] as const;

/** Stable color per user, identical on every screen and across reloads. */
export function colorFor(userId: string): string {
  // FNV-1a: a cheap, well-spread hash of the id's characters.
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return PEER_COLORS[(h >>> 0) % PEER_COLORS.length] as string;
}

/** Fraction of the remaining distance a remote cursor covers each frame (algorithms.md §8). */
const LERP = 0.3;
/** Close enough to stop animating, in world units. */
const SETTLE = 0.05;
/** A cursor that hasn't moved for this long is hidden (they left the window, or went idle). */
const CURSOR_IDLE_MS = 30_000;

export interface RemotePeer extends PeerInfo {
  color: string;
  /** Drawn position, eased toward `target`; null until their first cursor message. */
  cursor: { x: number; y: number } | null;
  target: { x: number; y: number } | null;
  lastMoved: number;
  selection: string[];
}

export interface OnlineUser {
  userId: string;
  name: string;
  color: string;
  isYou: boolean;
}

/**
 * Everyone else connected to this board: their cursors and selections. Purely local and
 * ephemeral (CLAUDE.md rule 9). React subscribes to `peers` (people joining or leaving) for the
 * online list; cursor movement only redraws the canvas overlay.
 */
export class Presence {
  readonly events = new Emitter<{ peers: undefined; moved: undefined }>();
  private readonly peers = new Map<string, RemotePeer>();
  private you: PeerInfo | null = null;
  private onlineSnapshot: readonly OnlineUser[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** On welcome: who I am and who else is here. */
  reset(you: PeerInfo, peers: readonly PeerInfo[]): void {
    this.you = you;
    this.peers.clear();
    for (const p of peers) this.add(p);
    this.changed();
  }

  join(peer: PeerInfo): void {
    this.add(peer);
    this.changed();
  }

  leave(peerId: string): void {
    if (this.peers.delete(peerId)) this.changed();
  }

  /** Disconnected: nobody is shown until the next welcome. */
  clear(): void {
    if (this.peers.size === 0) return;
    this.peers.clear();
    this.changed();
  }

  cursor(peerId: string, x: number, y: number): void {
    const p = this.peers.get(peerId);
    if (!p) return;
    p.target = { x, y };
    p.cursor ??= { x, y }; // first sighting: appear in place rather than fly in from 0,0
    p.lastMoved = this.now();
    this.events.emit('moved', undefined);
  }

  select(peerId: string, ids: readonly string[]): void {
    const p = this.peers.get(peerId);
    if (!p) return;
    p.selection = [...ids];
    this.events.emit('moved', undefined);
  }

  /** Remote peers with a visible cursor or selection, for drawing. */
  visible(): RemotePeer[] {
    const now = this.now();
    return [...this.peers.values()].map((p) => (p.cursor && now - p.lastMoved > CURSOR_IDLE_MS ? { ...p, cursor: null } : p));
  }

  /**
   * Moves each drawn cursor 30% of the way to its latest target. 20 updates a second then look
   * like smooth 60 fps motion. Returns true while any cursor is still moving (keep animating).
   */
  step(): boolean {
    let moving = false;
    for (const p of this.peers.values()) {
      if (!p.cursor || !p.target) continue;
      const dx = p.target.x - p.cursor.x;
      const dy = p.target.y - p.cursor.y;
      if (Math.abs(dx) < SETTLE && Math.abs(dy) < SETTLE) {
        p.cursor = { ...p.target };
        continue;
      }
      p.cursor = { x: p.cursor.x + dx * LERP, y: p.cursor.y + dy * LERP };
      moving = true;
    }
    return moving;
  }

  /** The people online (one entry per user, however many tabs), me first. Stable between changes. */
  online(): readonly OnlineUser[] {
    return this.onlineSnapshot;
  }

  /** Read-only view for tests and the debug handle. */
  list(): RemotePeer[] {
    return [...this.peers.values()].map((p) => ({ ...p, selection: [...p.selection] }));
  }

  private add(peer: PeerInfo): void {
    this.peers.set(peer.peerId, { ...peer, color: colorFor(peer.userId), cursor: null, target: null, lastMoved: 0, selection: [] });
  }

  private changed(): void {
    const users = new Map<string, OnlineUser>();
    if (this.you) users.set(this.you.userId, { userId: this.you.userId, name: this.you.name, color: colorFor(this.you.userId), isYou: true });
    for (const p of this.peers.values()) {
      if (!users.has(p.userId)) users.set(p.userId, { userId: p.userId, name: p.name, color: p.color, isYou: false });
    }
    this.onlineSnapshot = [...users.values()];
    this.events.emit('peers', undefined);
  }
}
