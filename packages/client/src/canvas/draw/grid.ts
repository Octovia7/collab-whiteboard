import type { Box } from '@whiteboard/shared';

const BASE_SPACING = 40; // world units
const MIN_SCREEN_SPACING = 16; // px; closer than this the dots turn into noise
const DOT_PX = 1.5;

/**
 * Background dot grid in world space, so panning and zooming are visible on an empty board.
 * Spacing doubles while dots would be closer than MIN_SCREEN_SPACING on screen, which caps
 * the dot count at roughly (viewport px / 16)^2 at any zoom.
 */
export function drawGrid(ctx: CanvasRenderingContext2D, view: Box, zoom: number): void {
  let spacing = BASE_SPACING;
  while (spacing * zoom < MIN_SCREEN_SPACING) spacing *= 2;
  // Dots are UI, not content: keep them the same size on screen at every zoom.
  const r = DOT_PX / zoom;

  ctx.fillStyle = '#c9ced6';
  ctx.beginPath();
  // One path, one fill: thousands of separate fillRect calls are much slower.
  for (let x = Math.floor(view.minX / spacing) * spacing; x <= view.maxX; x += spacing) {
    for (let y = Math.floor(view.minY / spacing) * spacing; y <= view.maxY; y += spacing) {
      ctx.rect(x - r / 2, y - r / 2, r, r);
    }
  }
  ctx.fill();
}
