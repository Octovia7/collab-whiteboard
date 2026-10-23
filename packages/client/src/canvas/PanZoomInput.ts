import type { Camera } from './Camera';

/** Wheel sensitivity: zoom factor = exp(-deltaY * k). exp makes in/out symmetric and smooth on trackpads. */
const WHEEL_ZOOM_SPEED = 0.0015;
/** Trackpad pinch arrives as ctrl+wheel with much smaller deltas. */
const PINCH_ZOOM_SPEED = 0.01;
/** deltaMode 1 means the delta is in lines, not pixels; roughly 33 px per line. */
const LINE_HEIGHT_PX = 33;

/**
 * Pan and zoom input (algorithms.md §10): the wheel zooms around the cursor; middle-drag
 * or space+drag pans. Other pointer input is left for the tools (milestone 3).
 */
export class PanZoomInput {
  private spaceDown = false;
  private panPointer: number | null = null;
  private last = { x: 0, y: 0 };
  private baseCursor = '';

  constructor(
    private readonly el: HTMLElement,
    private readonly camera: Camera,
  ) {}

  /** While space is held, primary-button drags belong to panning, not to the active tool. */
  get spaceHeld(): boolean {
    return this.spaceDown;
  }

  /** The active tool's cursor, shown whenever no pan is in progress. */
  setBaseCursor(cursor: string): void {
    this.baseCursor = cursor;
    this.updateCursor();
  }

  /** Returns a detach function. */
  attach(): () => void {
    const { el } = this;
    // passive: false so preventDefault stops the page itself from scrolling or zooming.
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    return () => {
      el.removeEventListener('wheel', this.onWheel);
      el.removeEventListener('pointerdown', this.onPointerDown);
      el.removeEventListener('pointermove', this.onPointerMove);
      el.removeEventListener('pointerup', this.onPointerUp);
      el.removeEventListener('pointercancel', this.onPointerUp);
      el.removeEventListener('mousedown', this.onMouseDown);
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onBlur);
    };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.el.getBoundingClientRect();
    const delta = e.deltaMode === 1 ? e.deltaY * LINE_HEIGHT_PX : e.deltaY;
    const speed = e.ctrlKey ? PINCH_ZOOM_SPEED : WHEEL_ZOOM_SPEED;
    this.camera.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-delta * speed));
  };

  private onPointerDown = (e: PointerEvent) => {
    const wantsPan = e.button === 1 || (e.button === 0 && this.spaceDown);
    if (!wantsPan || this.panPointer !== null) return;
    this.panPointer = e.pointerId;
    this.last = { x: e.clientX, y: e.clientY };
    // Capture so the drag keeps working when the pointer leaves the canvas.
    this.el.setPointerCapture(e.pointerId);
    this.updateCursor();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== this.panPointer) return;
    // Screen deltas; the camera divides by zoom so the board tracks the pointer exactly.
    this.camera.panBy(e.clientX - this.last.x, e.clientY - this.last.y);
    this.last = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== this.panPointer) return;
    this.panPointer = null;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    this.updateCursor();
  };

  /** Stops the browser's middle-click autoscroll from starting on top of our pan. */
  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
    e.preventDefault(); // otherwise space scrolls or presses a focused button
    this.spaceDown = true;
    this.updateCursor();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== 'Space') return;
    this.spaceDown = false;
    this.updateCursor();
  };

  /** Alt-tabbing away with space held never delivers the keyup. */
  private onBlur = () => {
    this.spaceDown = false;
    this.updateCursor();
  };

  private updateCursor(): void {
    this.el.style.cursor = this.panPointer !== null ? 'grabbing' : this.spaceDown ? 'grab' : this.baseCursor;
  }
}

export function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}
