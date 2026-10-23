import type { BoardSnapshot, Point, Shape } from '@whiteboard/shared';
import type { Camera } from './canvas/Camera';
import type { BoardStore } from './store/BoardStore';
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
  camera: Camera;
  selection: Selection;
  tools: ToolController;
}): () => void {
  const { boardId, store, sync, camera, selection, tools } = parts;
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
  });
  return () => {
    delete window.__board;
  };
}
