import type { ShapeId } from '@whiteboard/shared';
import { Emitter } from '../lib/Emitter';

/**
 * The local user's selected shape ids. Purely local UI state: it is never an op (milestone 6
 * broadcasts it as ephemeral presence). React subscribes to this, not to the board.
 */
export class Selection {
  readonly events = new Emitter<{ change: undefined }>();
  private ids = new Set<ShapeId>();
  /** Cached array so useSyncExternalStore sees the same snapshot until something changes. */
  private snapshot: readonly ShapeId[] = [];

  get size(): number {
    return this.ids.size;
  }

  has(id: ShapeId): boolean {
    return this.ids.has(id);
  }

  list(): readonly ShapeId[] {
    return this.snapshot;
  }

  set(ids: Iterable<ShapeId>): void {
    const next = new Set(ids);
    if (next.size === this.ids.size && [...next].every((id) => this.ids.has(id))) return;
    this.ids = next;
    this.changed();
  }

  toggle(id: ShapeId): void {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this.changed();
  }

  clear(): void {
    if (this.ids.size > 0) this.set([]);
  }

  /** Drops ids that fail `keep`, e.g. shapes someone else just deleted. */
  retain(keep: (id: ShapeId) => boolean): void {
    const next = [...this.ids].filter(keep);
    if (next.length !== this.ids.size) this.set(next);
  }

  private changed(): void {
    this.snapshot = [...this.ids];
    this.events.emit('change', undefined);
  }
}
