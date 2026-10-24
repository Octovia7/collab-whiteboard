import type { Point } from '@whiteboard/shared';
import { DRAG_THRESHOLD_PX } from './constants';
import type { Tool, ToolContext, ToolPointer } from './Tool';

/** A click (no drag) makes a note this size, in world units. */
export const DEFAULT_NOTE = { w: 200, h: 150 } as const;
/** Notes are tinted with their color; the default black would make a grey note, so use yellow. */
export const DEFAULT_NOTE_COLOR = '#f08c00';

/**
 * Sticky notes: click for a default-size note, or drag out its size. Releasing creates it,
 * selects it and opens the text editor right away (system-design.md, "Tools": "Create note,
 * open textarea overlay"); the text is saved on blur as one LWW update.
 */
export class NoteTool implements Tool {
  readonly cursor = 'crosshair';
  private start: { p: Point; pointerId: number } | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly openEditor: (id: string) => void,
  ) {}

  onPointerDown(p: Point, e: ToolPointer): void {
    this.start = { p, pointerId: e.pointerId };
    this.ctx.selection.clear();
  }

  onPointerMove(): void {
    // The note appears on release; there is nothing to preview for a click.
  }

  onPointerUp(p: Point, e: ToolPointer): void {
    const start = this.start;
    if (!start || start.pointerId !== e.pointerId) return;
    this.start = null;
    const { store, camera } = this.ctx;
    const dragged = Math.hypot(p.x - start.p.x, p.y - start.p.y) * camera.zoom >= DRAG_THRESHOLD_PX;
    const box = dragged
      ? { x: Math.min(start.p.x, p.x), y: Math.min(start.p.y, p.y), w: Math.abs(p.x - start.p.x), h: Math.abs(p.y - start.p.y) }
      : { x: start.p.x, y: start.p.y, ...DEFAULT_NOTE };
    const picked = this.ctx.color();
    const color = picked === '#1e1e1e' ? DEFAULT_NOTE_COLOR : picked;
    const op = store.makeCreate({ type: 'note', ...box, color, text: '' });
    store.submit([op]);
    this.ctx.selection.set([op.shape.id]);
    this.ctx.setTool('select');
    this.openEditor(op.shape.id);
  }

  cancel(): void {
    this.start = null;
  }
}
