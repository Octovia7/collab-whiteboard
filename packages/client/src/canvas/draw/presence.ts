import { expandBox } from '@whiteboard/shared';
import type { Box } from '@whiteboard/shared';
import type { RemotePeer } from '../../store/Presence';

/**
 * Other people's cursors (an arrow plus their name) and selections (an outline in their
 * color), on the overlay in world coordinates. Sizes are divided by zoom so they look the
 * same at every zoom level. Names go through fillText: canvas text can't inject HTML.
 */
export function drawPresence(ctx: CanvasRenderingContext2D, zoom: number, peers: readonly RemotePeer[], boundsOf: (id: string) => Box | undefined): void {
  const px = 1 / zoom;
  for (const peer of peers) {
    ctx.strokeStyle = peer.color;
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    for (const id of peer.selection) {
      const b = boundsOf(id);
      if (!b) continue;
      const o = expandBox(b, 6 * px);
      ctx.strokeRect(o.minX, o.minY, o.maxX - o.minX, o.maxY - o.minY);
    }
    ctx.setLineDash([]);
  }
  // Soft lock: a note someone is typing in gets their color and an "is typing" tag.
  for (const peer of peers) {
    if (!peer.typing) continue;
    const b = boundsOf(peer.typing);
    if (!b) continue;
    ctx.strokeStyle = peer.color;
    ctx.lineWidth = 3 * px;
    ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    ctx.font = `${12 * px}px system-ui, sans-serif`;
    const label = `${peer.name} is typing…`;
    const w = ctx.measureText(label).width + 10 * px;
    ctx.fillStyle = peer.color;
    ctx.fillRect(b.minX, b.minY - 20 * px, w, 18 * px);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, b.minX + 5 * px, b.minY - 11 * px);
  }
  for (const peer of peers) {
    if (!peer.cursor) continue;
    const { x, y } = peer.cursor;
    // Arrow pointer, tip at (x, y).
    ctx.fillStyle = peer.color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 16 * px);
    ctx.lineTo(x + 4.5 * px, y + 12 * px);
    ctx.lineTo(x + 11 * px, y + 12 * px);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Name tag.
    ctx.font = `${12 * px}px system-ui, sans-serif`;
    const label = peer.name;
    const w = ctx.measureText(label).width + 10 * px;
    const lx = x + 10 * px;
    const ly = y + 16 * px;
    ctx.fillStyle = peer.color;
    ctx.fillRect(lx, ly, w, 18 * px);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 5 * px, ly + 9 * px);
  }
}
