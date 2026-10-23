import { LINE_WIDTH } from '../canvas/draw/style';

/**
 * Interaction sizes are fixed in screen pixels and divided by zoom to get world units, so
 * handles stay grabbable and thin lines stay clickable at every zoom level.
 */
export const HANDLE_PX = 8;
export const HIT_TOLERANCE_PX = 6;
/** Pointer travel (screen px) before a press becomes a drag, so a click doesn't nudge shapes. */
export const DRAG_THRESHOLD_PX = 3;

export const SELECTION_COLOR = '#4dabf7';

/** World-unit tolerance for hitTest: half the drawn line plus the fixed screen tolerance. */
export function hitTolerance(zoom: number): number {
  return LINE_WIDTH / 2 + HIT_TOLERANCE_PX / zoom;
}
