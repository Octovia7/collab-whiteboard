import type { Op, ShapeProps, UpdateOp } from '@whiteboard/shared';

/**
 * Adds `op` to the outbox of not-yet-sent ops, dropping the parts of earlier unsent updates
 * that `op` overwrites (algorithms.md §1, "Batching": {x:101} then {x:104} sends just {x:104}).
 *
 * Why only *drop* props and never merge them under the newer stamp: our own board stored
 * every earlier prop with its original, smaller stamp. Re-sending y under the newer stamp
 * would make peers hold y@7 while we hold y@5; a remote y@6 would then win here and lose
 * there, and the replicas would diverge. A dropped prop is safe because the later update
 * from this same client has a strictly larger stamp and covers it, so it would have lost
 * every LWW comparison anyway.
 *
 * Creates and appends are never touched: a create must stay a full shape, and chunks are a
 * union, not overwrites.
 */
export function enqueueCoalesced(outbox: Op[], op: Op): void {
  if (op.kind === 'update') {
    const covered = new Set(Object.keys(op.props));
    for (let i = outbox.length - 1; i >= 0; i--) {
      const prev = outbox[i] as Op;
      if (prev.kind !== 'update' || prev.id !== op.id) continue;
      const remaining = Object.fromEntries(Object.entries(prev.props).filter(([key]) => !covered.has(key))) as Partial<ShapeProps>;
      if (Object.keys(remaining).length === 0) outbox.splice(i, 1);
      else outbox[i] = { ...prev, props: remaining } satisfies UpdateOp;
    }
  }
  outbox.push(op);
}
