import type { Op, PropKey, ShapeId, ShapeProps } from '@whiteboard/shared';
import { Emitter } from '../lib/Emitter';
import type { BoardStore } from './BoardStore';

/** Kept per tab; older entries fall off the bottom. */
const MAX_ENTRIES = 100;

interface Change {
  id: ShapeId;
  key: PropKey;
  /** Value before the first write in this step (undefined = the property didn't exist). */
  before: unknown;
  /** Value after the last write in this step. */
  after: unknown;
}

/** One undo step: one user action, however many ops it produced (a drag is dozens of moves). */
interface Entry {
  changes: Map<string, Change>;
  /** Shapes created in this step: undo deletes them, redo restores them. */
  created: Set<ShapeId>;
}

const emptyEntry = (): Entry => ({ changes: new Map(), created: new Set() });
const isEmpty = (e: Entry) => e.changes.size === 0 && e.created.size === 0;

/**
 * Per-user undo/redo (algorithms.md §9). Only this tab's own edits are recorded, by watching
 * local submits; undo sends the inverse as brand-new ops with fresh stamps, so it syncs and
 * merges like any other edit and beats the value it undoes.
 *
 * - A step is a transaction: `begin()` at pointer-down, `commit()` at pointer-up (one drag =
 *   one step). A submit outside a transaction is its own step (a keyboard delete, a recolor).
 * - Undo skips any property someone else wrote after us (its stamp's client isn't ours), so
 *   undoing never wipes out a collaborator's later change.
 * - Created shapes undo by `deleted: true`; tombstones make the redo (`deleted: false`) possible.
 */
export class History {
  readonly events = new Emitter<{ change: undefined }>();
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private open: Entry | null = null;
  private depth = 0;
  /** True while undo/redo submits, so those ops aren't recorded as a new step. */
  private replaying = false;
  private readonly off: () => void;

  constructor(private readonly store: BoardStore) {
    this.off = store.events.on('beforeSubmit', ({ ops }) => this.record(ops));
  }

  dispose(): void {
    this.off();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Starts a step. Nested begins join the outer step. */
  begin(): void {
    if (this.depth++ === 0) this.open = emptyEntry();
  }

  /** Ends the step; an empty step (a click that changed nothing) leaves no trace. */
  commit(): void {
    if (this.depth === 0) return;
    if (--this.depth > 0) return;
    const entry = this.open;
    this.open = null;
    if (entry && !isEmpty(entry)) this.push(entry);
  }

  undo(): void {
    this.replay(this.undoStack, this.redoStack, 'undo');
  }

  redo(): void {
    this.replay(this.redoStack, this.undoStack, 'redo');
  }

  private push(entry: Entry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    this.redoStack.length = 0; // a new action invalidates what was undone
    this.events.emit('change', undefined);
  }

  private record(ops: Op[]): void {
    if (this.replaying) return;
    const standalone = this.open === null;
    const entry = this.open ?? emptyEntry();
    for (const op of ops) {
      if (op.kind === 'create') {
        entry.created.add(op.shape.id);
      } else if (op.kind === 'update') {
        // Changes to a shape created in this same step need no inverse: undo deletes it whole.
        if (entry.created.has(op.id)) continue;
        for (const key of Object.keys(op.props) as PropKey[]) {
          const value = op.props[key];
          if (value === undefined) continue;
          const k = `${op.id}\u0000${key}`;
          const change = entry.changes.get(k);
          // The value before the step is captured only on the first write; later writes in the
          // same step (every move of a drag) just update where it ended up.
          if (change) change.after = value;
          else entry.changes.set(k, { id: op.id, key, before: this.priorValue(op.id, key), after: value });
        }
      }
      // Stroke appends belong to the stroke's create, which already undoes the whole stroke.
    }
    if (standalone && !isEmpty(entry)) this.push(entry);
  }

  /** A shape that was never deleted has no `deleted` register: that means false, and undo must restore it. */
  private priorValue(id: ShapeId, key: PropKey): unknown {
    const value = this.store.prop(id, key);
    return value === undefined && key === 'deleted' ? false : value;
  }

  /**
   * Pops entries until one actually changes something (its properties may all have been
   * overwritten by others since), submits it, and moves it to the other stack.
   */
  private replay(from: Entry[], to: Entry[], direction: 'undo' | 'redo'): void {
    if (this.depth > 0) return; // never in the middle of a gesture
    for (let entry = from.pop(); entry; entry = from.pop()) {
      const ops = this.opsFor(entry, direction);
      to.push(entry);
      if (ops.length === 0) continue;
      this.replaying = true;
      try {
        this.store.submit(ops);
      } finally {
        this.replaying = false;
      }
      break;
    }
    this.events.emit('change', undefined);
  }

  private opsFor(entry: Entry, direction: 'undo' | 'redo'): Op[] {
    const { store } = this;
    const mine = (id: ShapeId, key: PropKey) => store.propStamp(id, key)?.client === store.clientId;
    const byShape = new Map<ShapeId, Partial<ShapeProps>>();
    const set = (id: ShapeId, key: PropKey, value: unknown) => {
      const props = byShape.get(id) ?? {};
      (props as Record<string, unknown>)[key] = value;
      byShape.set(id, props);
    };
    for (const id of entry.created) {
      if (!store.get(id)) continue;
      // A shape nobody has deleted yet has no `deleted` register; then it's ours if we made it.
      const d = store.propStamp(id, 'deleted');
      const ours = d === undefined ? id.startsWith(`${store.clientId}-`) : d.client === store.clientId;
      if (ours) set(id, 'deleted', direction === 'undo');
    }
    for (const c of entry.changes.values()) {
      const value = direction === 'undo' ? c.before : c.after;
      // undefined can't be written (JSON drops it), and a property someone else wrote after us
      // is theirs now: leave it alone.
      if (value === undefined || !store.get(c.id) || !mine(c.id, c.key)) continue;
      set(c.id, c.key, value);
    }
    return [...byShape].map(([id, props]) => store.makeUpdate(id, props));
  }
}
