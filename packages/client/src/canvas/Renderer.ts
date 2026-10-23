import type { BoardStore } from '../store/BoardStore';
import type { Camera } from './Camera';
import { drawShape } from './draw';
import { drawGrid } from './draw/grid';

export type OverlayDrawer = (ctx: CanvasRenderingContext2D, camera: Camera) => void;

/**
 * Draws the board on two stacked canvases (system-design.md, "Renderer"):
 * - scene: grid + shapes; redrawn when the board or camera changes
 * - overlay: previews, selection, cursors (filled in by later milestones); redrawn on its own
 *   flag, so e.g. a moving remote cursor doesn't force every shape to be redrawn
 * Frames are requested only when a layer is dirty, so an idle board costs nothing.
 */
export class Renderer {
  private sceneDirty = true;
  private overlayDirty = true;
  private frameRequested = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private overlayDrawer: OverlayDrawer | null = null;
  private cleanups: (() => void)[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly scene: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
    private readonly store: BoardStore,
    private readonly camera: Camera,
  ) {}

  start(): void {
    this.cleanups.push(
      this.store.events.on('change', () => {
        this.markSceneDirty();
        // Selection outlines follow their shapes, including when someone else moves them.
        this.markOverlayDirty();
      }),
    );
    this.cleanups.push(
      this.camera.events.on('change', () => {
        this.markSceneDirty();
        this.markOverlayDirty();
      }),
    );
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.container);
    this.cleanups.push(() => ro.disconnect());
    this.watchPixelRatio();
    this.resize();
  }

  stop(): void {
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    cancelAnimationFrame(this.frameRequested);
    this.frameRequested = 0;
  }

  setOverlayDrawer(fn: OverlayDrawer | null): void {
    this.overlayDrawer = fn;
    this.markOverlayDirty();
  }

  markSceneDirty(): void {
    this.sceneDirty = true;
    this.requestFrame();
  }

  markOverlayDirty(): void {
    this.overlayDirty = true;
    this.requestFrame();
  }

  /** CSS-pixel size of the drawing area. */
  get size(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight };
  }

  private requestFrame(): void {
    // Many changes in one tick (a batch of remote ops) still produce a single draw.
    if (this.frameRequested) return;
    this.frameRequested = requestAnimationFrame(() => {
      this.frameRequested = 0;
      if (this.sceneDirty) this.drawScene();
      if (this.overlayDirty) this.drawOverlay();
    });
  }

  private resize(): void {
    this.cssWidth = this.container.clientWidth;
    this.cssHeight = this.container.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    for (const canvas of [this.scene, this.overlay]) {
      // Backing store in device pixels, displayed at CSS size: otherwise HiDPI screens
      // upscale a low-resolution bitmap and everything looks blurry.
      canvas.width = Math.round(this.cssWidth * this.dpr);
      canvas.height = Math.round(this.cssHeight * this.dpr);
      canvas.style.width = `${this.cssWidth}px`;
      canvas.style.height = `${this.cssHeight}px`;
    }
    this.markSceneDirty();
    this.markOverlayDirty();
  }

  /**
   * ResizeObserver doesn't fire when the window moves to a screen with a different
   * devicePixelRatio, so watch a media query for the current ratio and re-arm it on change.
   */
  private watchPixelRatio(): void {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => {
      this.resize();
      this.watchPixelRatio();
    };
    mq.addEventListener('change', onChange, { once: true });
    this.cleanups.push(() => mq.removeEventListener('change', onChange));
  }

  private drawScene(): void {
    this.sceneDirty = false;
    const ctx = this.scene.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.scene.width, this.scene.height);

    // From here on everything is drawn in world coordinates.
    ctx.setTransform(...this.camera.transform(this.dpr));
    const view = this.camera.viewport(this.cssWidth, this.cssHeight);
    drawGrid(ctx, view, this.camera.zoom);
    for (const shape of this.store.visibleIn(view)) drawShape(ctx, shape);
  }

  private drawOverlay(): void {
    this.overlayDirty = false;
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.overlayDrawer) return;
    ctx.setTransform(...this.camera.transform(this.dpr));
    this.overlayDrawer(ctx, this.camera);
  }
}
