import { expandBox } from '@whiteboard/shared';
import type { Op, Point, ShapeId } from '@whiteboard/shared';
import type { Camera } from '../canvas/Camera';
import { Emitter } from '../lib/Emitter';
import type { BoardStore } from '../store/BoardStore';
import type { Selection } from '../store/Selection';
import { HANDLE_PX, SELECTION_COLOR } from './constants';
import { handlesFor } from './handles';
import { keysAbove, keysBelow } from './reorder';
import { EraserTool } from './EraserTool';
import { PenTool } from './PenTool';
import { SelectTool } from './SelectTool';
import { ShapeTool } from './ShapeTool';
import type { Tool, ToolContext, ToolName, ToolPointer } from './Tool';

export const COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5'] as const;

const SHORTCUTS: Record<string, ToolName> = { v: 'select', r: 'rect', o: 'ellipse', a: 'arrow', p: 'pen', e: 'eraser' };

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Owns the active tool and current color, routes world-space pointer input to the tool,
 * and implements selection actions (delete, recolor, reorder). Everything it changes on the
 * board goes through store.submit. React subscribes to `events` for the toolbar only.
 */
export class ToolController {
  readonly events = new Emitter<{ change: undefined }>();
  private tools: Record<ToolName, Tool>;
  private current: ToolName = 'select';
  /** Viewers: no selection, no drawing, no edit shortcuts. Pan and zoom live elsewhere and still work. */
  private readOnlyMode = false;
  private currentColor: string = COLORS[0];
  private readonly ctx: ToolContext;

  constructor(
    private readonly store: BoardStore,
    private readonly selection: Selection,
    private readonly camera: Camera,
    redrawOverlay: () => void,
    now: () => number = () => performance.now(),
  ) {
    this.ctx = {
      store,
      selection,
      camera,
      color: () => this.currentColor,
      setTool: (name) => this.setTool(name),
      redrawOverlay,
      now,
    };
    this.tools = {
      select: new SelectTool(this.ctx),
      rect: new ShapeTool('rect', this.ctx),
      ellipse: new ShapeTool('ellipse', this.ctx),
      arrow: new ShapeTool('arrow', this.ctx),
      pen: new PenTool(this.ctx),
      eraser: new EraserTool(this.ctx),
    };
  }

  get tool(): ToolName {
    return this.current;
  }

  get color(): string {
    return this.currentColor;
  }

  get cursor(): string {
    return this.tools[this.current].cursor;
  }

  get readOnly(): boolean {
    return this.readOnlyMode;
  }

  /**
   * Switches read-only mode live (on welcome and whenever the role changes). Entering it
   * abandons any gesture in progress, clears the selection and returns to the select tool,
   * so no edit can start; the server would reject a viewer's ops anyway.
   */
  setReadOnly(on: boolean): void {
    if (on === this.readOnlyMode) return;
    this.readOnlyMode = on;
    if (on) {
      this.tools[this.current].cancel();
      this.current = 'select';
      this.selection.clear();
    }
    this.events.emit('change', undefined);
    this.ctx.redrawOverlay();
  }

  setTool(name: ToolName): void {
    if (this.readOnlyMode && name !== 'select') return;
    if (name === this.current) return;
    this.tools[this.current].cancel();
    this.current = name;
    this.events.emit('change', undefined);
  }

  /** Sets the color for new shapes and recolors the selection, as one batch. */
  setColor(color: string): void {
    if (this.readOnlyMode) return;
    this.currentColor = color;
    this.submitForSelection((id) => this.store.makeUpdate(id, { color }));
    this.events.emit('change', undefined);
  }

  pointerDown(p: Point, e: ToolPointer): void {
    if (this.readOnlyMode) return;
    this.tools[this.current].onPointerDown(p, e);
  }

  pointerMove(p: Point, e: ToolPointer): void {
    if (this.readOnlyMode) return;
    this.tools[this.current].onPointerMove(p, e);
  }

  pointerUp(p: Point, e: ToolPointer): void {
    if (this.readOnlyMode) return;
    this.tools[this.current].onPointerUp(p, e);
  }

  /** Pointer moved with no button down (null: it left the board). */
  pointerHover(p: Point | null): void {
    if (this.readOnlyMode) return;
    this.tools[this.current].onPointerHover?.(p);
  }

  cancelGesture(): void {
    this.tools[this.current].cancel();
  }

  /** Returns true if the key was handled (the caller then prevents the browser default). */
  keyDown(e: KeyInput): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey || this.readOnlyMode) return false;
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        this.deleteSelection();
        return true;
      case 'Escape':
        this.cancelGesture();
        this.selection.clear();
        this.setTool('select');
        return true;
      case ']':
        this.bringToFront();
        return true;
      case '[':
        this.sendToBack();
        return true;
    }
    const tool = SHORTCUTS[e.key.toLowerCase()];
    if (tool) {
      this.setTool(tool);
      return true;
    }
    return false;
  }

  /** Delete = update { deleted: true }: the shapes become tombstones. */
  deleteSelection(): void {
    if (this.readOnlyMode) return;
    this.submitForSelection((id) => this.store.makeUpdate(id, { deleted: true }));
    this.selection.clear();
  }

  /** One z update per moved shape, keeping the selection's own stacking order. */
  bringToFront(): void {
    if (this.readOnlyMode) return;
    const ids = this.visibleSelection();
    const keys = keysAbove(this.store.topZ(), ids.length);
    this.store.submit(ids.map((id, i) => this.store.makeUpdate(id, { z: keys[i] as string })));
  }

  sendToBack(): void {
    if (this.readOnlyMode) return;
    const ids = this.visibleSelection();
    const keys = keysBelow(this.store.bottomZ(), ids.length);
    this.store.submit(ids.map((id, i) => this.store.makeUpdate(id, { z: keys[i] as string })));
  }

  /** Selection outlines, handles and the active tool's preview, in world coordinates. */
  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const px = 1 / camera.zoom; // one screen pixel in world units
    const ids = this.visibleSelection();
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = px;
    for (const id of ids) {
      const b = this.store.boundsOf(id);
      if (!b) continue;
      const o = expandBox(b, 4 * px);
      ctx.strokeRect(o.minX, o.minY, o.maxX - o.minX, o.maxY - o.minY);
    }
    if (ids.length === 1) {
      const shape = this.store.get(ids[0] as ShapeId);
      const size = HANDLE_PX * px;
      ctx.fillStyle = '#ffffff';
      for (const h of shape ? handlesFor(shape) : []) {
        ctx.fillRect(h.x - size / 2, h.y - size / 2, size, size);
        ctx.strokeRect(h.x - size / 2, h.y - size / 2, size, size);
      }
    }
    this.tools[this.current].drawOverlay?.(ctx, camera);
  }

  private visibleSelection(): ShapeId[] {
    return this.store.sortByDrawOrder(this.selection.list().filter((id) => this.store.isVisible(id)));
  }

  private submitForSelection(makeOp: (id: ShapeId) => Op): void {
    this.store.submit(this.visibleSelection().map(makeOp));
  }
}
