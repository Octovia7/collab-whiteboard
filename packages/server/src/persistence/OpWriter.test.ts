import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { StoredOp } from './OpStore';
import { OpWriter } from './OpWriter';
import type { Repo } from './repo';

const log = { info: () => {}, warn: () => {}, error: () => {} } as unknown as FastifyBaseLogger;
const op = (n: number): StoredOp => ({
  boardId: 'b',
  seq: n,
  opId: `o${n}`,
  userId: 'u',
  op: { kind: 'update', opId: `o${n}`, stamp: { t: n, client: 'c' }, id: 'c-1', props: { x: n } },
});

/** A repo whose inserts the test controls. */
function fakeRepo(insert: () => Promise<string[]>): Repo {
  return { insertOps: insert } as unknown as Repo;
}

describe('OpWriter saving paused', () => {
  it('a commit that hangs (Postgres frozen) pauses saving after pauseAfterMs, before it ever fails', async () => {
    let release: () => void = () => {};
    const hung = new Promise<string[]>((r) => (release = () => r([])));
    const writer = new OpWriter(fakeRepo(() => hung), log, { pauseAfterMs: 100 });
    const changes: boolean[] = [];
    writer.onPausedChange((p) => changes.push(p));
    const committed = writer.append([op(1)]);
    await new Promise((r) => setTimeout(r, 250));
    expect(writer.paused).toBe(true);
    release();
    expect(await committed).toEqual([]);
    expect(writer.paused).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('counts the outage from the first attempt, not from the first failure', async () => {
    // Each attempt hangs 80 ms and then fails: with a 150 ms threshold, saving pauses during
    // the second attempt, not 150 ms after the first failure.
    let fail = true;
    const writer = new OpWriter(
      fakeRepo(async () => {
        await new Promise((r) => setTimeout(r, 80));
        if (fail) throw new Error('connection timeout');
        return [];
      }),
      log,
      { pauseAfterMs: 150 },
    );
    const started = performance.now();
    const committed = writer.append([op(1)]);
    while (!writer.paused) await new Promise((r) => setTimeout(r, 5));
    expect(performance.now() - started).toBeLessThan(260);
    fail = false;
    await committed;
    expect(writer.paused).toBe(false);
  });

  it('a commit that succeeds in time never pauses', async () => {
    const writer = new OpWriter(fakeRepo(async () => []), log, { pauseAfterMs: 100 });
    const changes: boolean[] = [];
    writer.onPausedChange((p) => changes.push(p));
    await writer.append([op(1)]);
    await new Promise((r) => setTimeout(r, 150));
    expect(changes).toEqual([]);
  });
});
