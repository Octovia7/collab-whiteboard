import type { Box, Point } from '@whiteboard/shared';
import { Emitter } from '../lib/Emitter';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

/**
 * Each user's private view of the infinite board (algorithms.md §10).
 * (x, y) is the world point at the screen's top-left corner; zoom 1 = 100%.
 *
 *   screen = (world - cam) * zoom        world = screen / zoom + cam
 *
 * Screen coordinates here are CSS pixels relative to the canvas. devicePixelRatio is only
 * applied when building the canvas transform, so input handling never needs to know it.
 * Nothing about the camera is ever synced or stored.
 */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  readonly events = new Emitter<{ change: undefined }>();

  toWorld(sx: number, sy: number): Point {
    return { x: sx / this.zoom + this.x, y: sy / this.zoom + this.y };
  }

  toScreen(wx: number, wy: number): Point {
    return { x: (wx - this.x) * this.zoom, y: (wy - this.y) * this.zoom };
  }

  /** Drag by (dx, dy) screen pixels: the board follows the pointer, so the camera moves the opposite way. */
  panBy(dxPx: number, dyPx: number): void {
    this.x -= dxPx / this.zoom;
    this.y -= dyPx / this.zoom;
    this.changed();
  }

  /** Multiply zoom by `factor`, keeping the world point under screen point (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.setZoomAt(sx, sy, this.zoom * factor);
  }

  /** Set an absolute zoom (clamped), anchored at screen point (sx, sy). */
  setZoomAt(sx: number, sy: number, zoom: number): void {
    const anchor = this.toWorld(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    // Solve world = screen / zoom + cam for cam, so the anchor lands back under the cursor.
    this.x = anchor.x - sx / this.zoom;
    this.y = anchor.y - sy / this.zoom;
    this.changed();
  }

  /** The world-space rectangle visible in a viewport of the given CSS size. */
  viewport(widthCss: number, heightCss: number): Box {
    return { minX: this.x, minY: this.y, maxX: this.x + widthCss / this.zoom, maxY: this.y + heightCss / this.zoom };
  }

  /**
   * Canvas transform mapping world coordinates to device pixels, for ctx.setTransform.
   * Setting it once per frame lets every shape be drawn in world units.
   */
  transform(dpr: number): [number, number, number, number, number, number] {
    const s = this.zoom * dpr;
    return [s, 0, 0, s, -this.x * s, -this.y * s];
  }

  private changed(): void {
    this.events.emit('change', undefined);
  }
}
