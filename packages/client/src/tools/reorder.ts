import { keyBetween } from '@whiteboard/shared';

/**
 * n new z keys above `top`, ascending. Assign them to the moved shapes in their current draw
 * order, so "bring to front" keeps the selection's own stacking. Each shape gets one z update.
 */
export function keysAbove(top: string, n: number): string[] {
  const keys: string[] = [];
  let prev = top;
  for (let i = 0; i < n; i++) {
    prev = keyBetween(prev, '');
    keys.push(prev);
  }
  return keys;
}

/** n new z keys below `bottom`, ascending; the mirror of keysAbove. */
export function keysBelow(bottom: string, n: number): string[] {
  const keys: string[] = [];
  let next = bottom;
  // Generate downwards from the current bottom, then flip to ascending order.
  for (let i = 0; i < n; i++) {
    next = keyBetween('', next);
    keys.push(next);
  }
  return keys.reverse();
}
