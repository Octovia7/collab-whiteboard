import type { BoardSnapshot, Point, Shape } from '@whiteboard/shared';
import type { Camera } from './canvas/Camera';
import type { BoardStore } from './store/BoardStore';
import type { Presence } from './store/Presence';
import type { Selection } from './store/Selection';
import type { ConnectionStatus, SyncClient } from './sync/SyncClient';
import type { ToolController } from './tools/ToolController';

/**
 * Read-only view of a tab's state for E2E tests (window.__board). Every getter returns a
 * fresh copy, so a test can't change the board through it; tests act only through real
 * pointer and keyboard input. Installed in dev builds only (see App.tsx); production
 * builds drop it entirely.
 */
export interface DebugHandle {
  boardId: string;
  clientId: string;
  /** Visible shapes in draw order (bottom first). */
  shapes(): Shape[];
  /** Full board state: every register with its stamp, tombstones included. */
  snapshot(): BoardSnapshot;
  selection(): string[];
  tool(): string;
  /** True while the UI is in viewer (read-only) mode. */
  readOnly(): boolean;
  camera(): { x: number; y: number; zoom: number };
  toScreen(x: number, y: number): Point;
  toWorld(x: number, y: number): Point;
  status(): ConnectionStatus;
  /** Role from welcome / live role changes; null before welcome. */
  role(): string | null;
  /** Local ops not yet acked by the server. */
  unacked(): number;
  /** A stroke's drawn points (relative to its x/y): pen-up points, or the streamed chunks. */
  strokePoints(id: string): number[];
  /** Other connections on this board, with their latest cursor target and selection. */
  peers(): { peerId: string; userId: string; name: string; color: string; target: { x: number; y: number } | null; selection: string[] }[];
  /** People online, me first. */
  online(): { name: string; isYou: boolean; color: string }[];
}

declare global {
  interface Window {
    __board?: DebugHandle;
  }
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const EVERYWHERE = { minX: -1e12, minY: -1e12, maxX: 1e12, maxY: 1e12 };

export function installDebugHandle(parts: {
  boardId: string;
  store: BoardStore;
  sync: SyncClient;
  presence: Presence;
  camera: Camera;
  selection: Selection;
  tools: ToolController;
}): () => void {
  const { boardId, store, sync, presence, camera, selection, tools } = parts;
  window.__board = Object.freeze({
    boardId,
    clientId: store.clientId,
    shapes: () => copy(store.visibleIn(EVERYWHERE)),
    snapshot: () => copy(store.snapshot()),
    selection: () => [...selection.list()],
    tool: () => tools.tool,
    readOnly: () => tools.readOnly,
    camera: () => ({ x: camera.x, y: camera.y, zoom: camera.zoom }),
    toScreen: (x: number, y: number) => camera.toScreen(x, y),
    toWorld: (x: number, y: number) => camera.toWorld(x, y),
    status: () => sync.status,
    role: () => sync.role,
    unacked: () => sync.unackedCount,
    strokePoints: (id: string) => [...store.strokePoints(id)],
    peers: () =>
      presence.list().map((p) => ({
        peerId: p.peerId,
        userId: p.userId,
        name: p.name,
        color: p.color,
        target: p.target ? { ...p.target } : null,
        selection: [...p.selection],
      })),
    online: () => presence.online().map((u) => ({ name: u.name, isYou: u.isYou, color: u.color })),
  });
  return () => {
    delete window.__board;
  };
}
