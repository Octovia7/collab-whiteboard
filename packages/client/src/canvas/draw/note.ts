import type { Shape } from '@whiteboard/shared';
import { LINE_WIDTH } from './style';

/** Note text size and padding, in world units (they scale with zoom, like the note). */
export const NOTE_FONT_SIZE = 16;
export const NOTE_PADDING = 12;
const LINE_HEIGHT = NOTE_FONT_SIZE * 1.3;
export const NOTE_FONT = `${NOTE_FONT_SIZE}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
export const NOTE_TEXT_COLOR = '#1e1e1e';

/** The parts of a 2D context word-wrapping needs; tests pass a fake measurer. */
export type Measurer = Pick<CanvasRenderingContext2D, 'measureText'>;

/**
 * Greedy word wrap to `width`: words go on the current line while they fit; a single word
 * wider than the line is broken by characters. Explicit newlines start new lines.
 */
export function wrapText(ctx: Measurer, text: string, width: number): string[] {
  const lines: string[] = [];
  const fits = (s: string) => ctx.measureText(s).width <= width;
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      // Break an overlong word into the widest pieces that fit.
      let rest = word;
      while (!fits(rest)) {
        let n = rest.length - 1;
        while (n > 1 && !fits(rest.slice(0, n))) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * A sticky note: a box tinted with its color, a solid border, and its text wrapped inside
 * (clipped to the box). Text goes through fillText, never HTML.
 */
export function drawNote(ctx: CanvasRenderingContext2D, s: Shape): void {
  const x = Math.min(s.x, s.x + s.w);
  const y = Math.min(s.y, s.y + s.h);
  const w = Math.abs(s.w);
  const h = Math.abs(s.h);
  ctx.save();
  ctx.fillStyle = s.color;
  ctx.globalAlpha = 0.22;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = LINE_WIDTH;
  ctx.strokeRect(x, y, w, h);
  if (s.text) {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.font = NOTE_FONT;
    ctx.fillStyle = NOTE_TEXT_COLOR;
    ctx.textBaseline = 'top';
    const lines = wrapText(ctx, s.text, Math.max(1, w - NOTE_PADDING * 2));
    lines.forEach((line, i) => ctx.fillText(line, x + NOTE_PADDING, y + NOTE_PADDING + i * LINE_HEIGHT));
  }
  ctx.restore();
}
