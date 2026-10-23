import { containsBox, overlaps } from '@whiteboard/shared';
import type { Box } from '@whiteboard/shared';

/** Split a node once it holds more than this many items. */
const MAX_ITEMS = 16;
/** Never split below this depth, so many shapes stacked in one spot can't recurse forever. */
const MAX_DEPTH = 10;
/** Half-size of the initial root square: plenty for a whiteboard; the root grows if needed. */
const INITIAL_HALF = 1_000_000;

interface Item {
  id: string;
  box: Box;
}

interface Node {
  bounds: Box;
  depth: number;
  items: Item[];
  kids: [Node, Node, Node, Node] | null;
}

/**
 * Region quadtree over shape bounding boxes (algorithms.md §11b). Queries skip every node
 * whose square misses the query box, so viewport culling and hit testing touch roughly
 * O(log N + k) shapes instead of all N.
 *
 * Each item lives in the deepest node that fully contains its box; boxes straddling a
 * dividing line stay in the parent. `where` remembers each item's node so an update is a
 * cheap remove + insert rather than a search.
 */
export class QuadTree {
  private root: Node;
  private where = new Map<string, { node: Node; item: Item }>();

  constructor(half = INITIAL_HALF) {
    this.root = newNode({ minX: -half, minY: -half, maxX: half, maxY: half }, 0);
  }

  get size(): number {
    return this.where.size;
  }

  has(id: string): boolean {
    return this.where.has(id);
  }

  /** Inserts or moves `id` to `box`. */
  set(id: string, box: Box): void {
    this.remove(id);
    if (!containsBox(this.root.bounds, box)) this.growToFit(box);
    this.insertItem(this.root, { id, box });
  }

  remove(id: string): void {
    const loc = this.where.get(id);
    if (!loc) return;
    const items = loc.node.items;
    const i = items.indexOf(loc.item);
    // Swap-remove: item order inside a node doesn't matter.
    items[i] = items[items.length - 1] as Item;
    items.pop();
    this.where.delete(id);
    // Empty child nodes are left in place: they cost one box check per query, and
    // collapsing them would just be undone when shapes come back.
  }

  /** Ids whose boxes overlap `q`, in no particular order. */
  query(q: Box): string[] {
    const out: string[] = [];
    const stack: Node[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop() as Node;
      // The pruning step: one check rejects this node and everything below it.
      if (!overlaps(node.bounds, q)) continue;
      for (const item of node.items) if (overlaps(item.box, q)) out.push(item.id);
      if (node.kids) stack.push(...node.kids);
    }
    return out;
  }

  private insertItem(start: Node, item: Item): void {
    let node = start;
    // Walk down while some child fully contains the box.
    for (;;) {
      if (!node.kids) break;
      const kid = node.kids.find((k) => containsBox(k.bounds, item.box));
      if (!kid) break;
      node = kid;
    }
    node.items.push(item);
    this.where.set(item.id, { node, item });
    if (!node.kids && node.items.length > MAX_ITEMS && node.depth < MAX_DEPTH) this.split(node);
  }

  private split(node: Node): void {
    const { minX, minY, maxX, maxY } = node.bounds;
    const mx = (minX + maxX) / 2;
    const my = (minY + maxY) / 2;
    const d = node.depth + 1;
    node.kids = [
      newNode({ minX, minY, maxX: mx, maxY: my }, d),
      newNode({ minX: mx, minY, maxX, maxY: my }, d),
      newNode({ minX, minY: my, maxX: mx, maxY }, d),
      newNode({ minX: mx, minY: my, maxX, maxY }, d),
    ];
    const old = node.items;
    node.items = [];
    for (const item of old) this.insertItem(node, item);
  }

  /** A shape landed outside the root: rebuild around a root twice as big until it fits. Rare. */
  private growToFit(box: Box): void {
    let half = this.root.bounds.maxX;
    const need = Math.max(Math.abs(box.minX), Math.abs(box.minY), Math.abs(box.maxX), Math.abs(box.maxY));
    while (half < need) half *= 2;
    const items = [...this.where.values()].map((loc) => loc.item);
    this.root = newNode({ minX: -half, minY: -half, maxX: half, maxY: half }, 0);
    this.where.clear();
    for (const item of items) this.insertItem(this.root, item);
  }
}

function newNode(bounds: Box, depth: number): Node {
  return { bounds, depth, items: [], kids: null };
}
