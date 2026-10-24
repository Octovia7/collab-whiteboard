import { expandBox } from '@whiteboard/shared';
import type { Op, Point, ShapeId } from '@whiteboard/shared';
import type { Camera } from '../canvas/Camera';
import { Emitter } from '../lib/Emitter';
import type { BoardStore } from '../store/BoardStore';
import type { History } from '../store/History';
import type { Selection } from '../store/Selection';
import { HANDLE_PX, SELECTION_COLOR, hitTolerance } from './constants';
import { handlesFor } from './handles';
import { keysAbove, keysBelow } from './reorder';
import { EraserTool } from './EraserTool';
import { NoteTool } from './NoteTool';
import { PenTool } from './PenTool';
import { SelectTool } from './SelectTool';
import { ShapeTool } from './ShapeTool';
import type { Tool, ToolContext, ToolName, ToolPointer } from './Tool';

export const COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5'] as const;

const SHORTCUTS: Record<string, ToolName> = { v: 'select', r: 'rect', o: 'ellipse', a: 'arrow', p: 'pen', e: 'eraser', n: 'note' };

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
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
  /** A pointer gesture is in progress: its edits form one undo step. */
  private gestureOpen = false;
  /** The note whose text editor is open, if any. */
  private editing: ShapeId | null = null;
  /** Whether someone else is typing in a note (set by the app from presence). */
  private noteLockedByOthers: (id: ShapeId) => boolean = () => false;

  constructor(
    private readonly store: BoardStore,
    private readonly selection: Selection,
    private readonly camera: Camera,
    redrawOverlay: () => void,
    now: () => number = () => performance.now(),
    private readonly history?: History,
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
      note: new NoteTool(this.ctx, (id) => this.startEditing(id)),
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

  /** The note being edited (its textarea is open), or null. */
  get editingNote(): ShapeId | null {
    return this.editing;
  }

  setNoteLock(lockedByOthers: (id: ShapeId) => boolean): void {
    this.noteLockedByOthers = lockedByOthers;
  }

  /**
   * Opens the text editor on a note, unless someone else is already typing in it (the soft
   * lock) or we're read-only. Returns whether it opened.
   */
  startEditing(id: ShapeId): boolean {
    if (this.readOnlyMode || this.store.get(id)?.type !== 'note' || !this.store.isVisible(id)) return false;
    if (this.noteLockedByOthers(id)) return false;
    this.editing = id;
    this.selection.set([id]);
    this.events.emit('change', undefined);
    return true;
  }

  /**
   * Closes the editor. The text is saved here, on blur, as one LWW update of the whole text
   * (and one undo step); nothing is sent while typing.
   */
  finishEditing(text: string): void {
    const id = this.editing;
    if (id === null) return;
    this.editing = null;
    if (this.store.isVisible(id) && (this.store.get(id)?.text ?? '') !== text) {
      this.store.submit([this.store.makeUpdate(id, { text })]);
    }
    this.events.emit('change', undefined);
  }

  /** Double-click: edit the note under the pointer. */
  doubleClick(p: Point): void {
    if (this.readOnlyMode) return;
    const id = this.store.hitTest(p, hitTolerance(this.camera.zoom));
    if (id !== null) this.startEditing(id);
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
      this.endGesture();
      // Demoted mid-edit: close without saving (the server would reject the text anyway).
      this.editing = null;
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
    this.endGesture();
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
    // Everything the gesture submits, until pointer-up, is one undo step (one drag = one step).
    this.endGesture();
    this.history?.begin();
    this.gestureOpen = true;
    this.tools[this.current].onPointerDown(p, e);
  }

  pointerMove(p: Point, e: ToolPointer): void {
    if (this.readOnlyMode) return;
    this.tools[this.current].onPointerMove(p, e);
  }

  pointerUp(p: Point, e: ToolPointer): void {
    if (this.readOnlyMode) return;
    this.tools[this.current].onPointerUp(p, e);
    this.endGesture();
  }

  /** Pointer moved with no button down (null: it left the board). */
  pointerHover(p: Point | null): void {
    if (this.readOnlyMode) return;
    this.tools[this.current].onPointerHover?.(p);
  }

  cancelGesture(): void {
    this.tools[this.current].cancel();
    this.endGesture();
  }

  /** Undo this tab's last step (algorithms.md §9). Viewers have nothing to undo. */
  undo(): void {
    if (this.readOnlyMode) return;
    this.cancelGesture();
    this.history?.undo();
  }

  redo(): void {
    if (this.readOnlyMode) return;
    this.cancelGesture();
    this.history?.redo();
  }

  private endGesture(): void {
    if (!this.gestureOpen) return;
    this.gestureOpen = false;
    this.history?.commit();
  }

  /** Returns true if the key was handled (the caller then prevents the browser default). */
  keyDown(e: KeyInput): boolean {
    if (this.readOnlyMode) return false;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') {
        if (e.shiftKey) this.redo();
        else this.undo();
        return true;
      }
      if (k === 'y') {
        this.redo();
        return true;
      }
      return false;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
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
