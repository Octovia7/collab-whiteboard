import type { Point } from '@whiteboard/shared';
import type { Camera } from '../canvas/Camera';
import type { BoardStore } from '../store/BoardStore';
import type { Selection } from '../store/Selection';

export type ToolName = 'select' | 'rect' | 'ellipse' | 'arrow';

/** The parts of a pointer event tools need. Kept DOM-free so tools are unit-testable. */
export interface ToolPointer {
  pointerId: number;
  shiftKey: boolean;
}

/** What a tool may touch. Edits go only through `store.submit`. */
export interface ToolContext {
  store: BoardStore;
  selection: Selection;
  camera: Camera;
  /** Color for new shapes. */
  color(): string;
  setTool(name: ToolName): void;
  /** Ask for an overlay redraw (previews, selection box). */
  redrawOverlay(): void;
}

/**
 * Every tool receives pointer positions already converted to world coordinates
 * (system-design.md, "Tools"; CLAUDE.md rule 10).
 */
export interface Tool {
  readonly cursor: string;
  onPointerDown(p: Point, e: ToolPointer): void;
  onPointerMove(p: Point, e: ToolPointer): void;
  onPointerUp(p: Point, e: ToolPointer): void;
  /** Abandon any gesture in progress (tool switch, Escape, lost pointer). */
  cancel(): void;
  /** Draw previews in world coordinates; the overlay transform is already set. */
  drawOverlay?(ctx: CanvasRenderingContext2D, camera: Camera): void;
}
