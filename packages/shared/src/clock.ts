import type { Stamp } from './types';

/**
 * Total order on stamps that every replica agrees on.
 * Returns > 0 when `a` is later than `b`, < 0 when earlier, 0 only for the same stamp.
 * Ties on `t` mean neither writer had seen the other's edit; comparing client IDs picks
 * an arbitrary but identical winner everywhere. Plain `<` (not localeCompare) so the
 * result can't depend on the machine's locale.
 */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.t !== b.t) return a.t - b.t;
  if (a.client < b.client) return -1;
  if (a.client > b.client) return 1;
  return 0;
}

/**
 * Lamport clock: guarantees that if you saw an edit before making yours, yours gets a
 * bigger stamp. That is the only meaning of "later" LWW needs; wall clocks drift.
 */
export class LamportClock {
  private time = 0;

  constructor(readonly clientId: string) {}

  get now(): number {
    return this.time;
  }

  /** Call before sending a change. */
  tick(): Stamp {
    this.time += 1;
    return { t: this.time, client: this.clientId };
  }

  /**
   * Call for every op received, including ops loaded from a snapshot, so a reloaded tab
   * never stamps an edit lower than something already on the board.
   * No +1 here: tick() always adds 1 before a send, which is enough to stay ahead.
   */
  observe(stamp: Stamp): void {
    if (stamp.t > this.time) this.time = stamp.t;
  }
}
