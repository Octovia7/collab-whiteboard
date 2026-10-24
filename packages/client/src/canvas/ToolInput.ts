import type { Point } from '@whiteboard/shared';
import type { ToolController } from '../tools/ToolController';
import type { Camera } from './Camera';
import { isTyping } from './PanZoomInput';
import type { PanZoomInput } from './PanZoomInput';

/**
 * Turns DOM pointer and key events into tool input. Every pointer position is converted to
 * world coordinates here, once, before any tool sees it (CLAUDE.md rule 10).
 * Middle-button and space+drag gestures are left to PanZoomInput.
 */
export class ToolInput {
  private activePointer: number | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly camera: Camera,
    private readonly tools: ToolController,
    private readonly panZoom: PanZoomInput,
    /** Every pointer position over the board, pressed or not (presence cursor). */
    private readonly onCursor: (p: Point) => void = () => {},
  ) {}

  attach(): () => void {
    const { el } = this;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerCancel);
    el.addEventListener('pointerleave', this.onPointerLeave);
    el.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('keydown', this.onKeyDown);
    const offTool = this.tools.events.on('change', () => this.panZoom.setBaseCursor(this.tools.cursor));
    this.panZoom.setBaseCursor(this.tools.cursor);
    return () => {
      el.removeEventListener('pointerdown', this.onPointerDown);
      el.removeEventListener('pointermove', this.onPointerMove);
      el.removeEventListener('pointerup', this.onPointerUp);
      el.removeEventListener('pointercancel', this.onPointerCancel);
      el.removeEventListener('pointerleave', this.onPointerLeave);
      el.removeEventListener('dblclick', this.onDoubleClick);
      window.removeEventListener('keydown', this.onKeyDown);
      offTool();
    };
  }

  private toWorld(e: PointerEvent) {
    const rect = this.el.getBoundingClientRect();
    return this.camera.toWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  private onPointerDown = (e: PointerEvent) => {
    // Primary button only; one gesture at a time (a second finger doesn't start another).
    if (e.button !== 0 || this.panZoom.spaceHeld || this.activePointer !== null) return;
    this.activePointer = e.pointerId;
    this.el.setPointerCapture(e.pointerId);
    this.tools.pointerDown(this.toWorld(e), e);
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.toWorld(e);
    this.onCursor(p);
    if (this.activePointer === null) this.tools.pointerHover(p);
    else if (e.pointerId === this.activePointer) this.tools.pointerMove(p, e);
  };

  private onDoubleClick = (e: MouseEvent) => {
    if (e.button !== 0 || this.panZoom.spaceHeld) return;
    const rect = this.el.getBoundingClientRect();
    this.tools.doubleClick(this.camera.toWorld(e.clientX - rect.left, e.clientY - rect.top));
  };

  private onPointerLeave = () => {
    if (this.activePointer === null) this.tools.pointerHover(null);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    this.tools.pointerUp(this.toWorld(e), e);
  };

  private onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    this.tools.cancelGesture();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.repeat) return;
    if (this.tools.keyDown(e)) e.preventDefault();
  };
}
