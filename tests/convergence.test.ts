/**
 * Randomized convergence test (system-design.md, "Testing"). N simulated clients make random
 * edits against their own view of the board; ops are delivered to everyone else in random
 * order, with random delays and duplicates. Once everything is delivered, every board must
 * be identical. `pnpm test` runs 50 seeds; `pnpm test:convergence` runs all 500.
 * Re-run one failing seed with CONVERGENCE_SEED=<n> pnpm test:convergence.
 */
import { describe, expect, it } from 'vitest';
import { Board, LamportClock, createIdGenerator, keyBetween } from '@whiteboard/shared';
import type { Op, ShapeId, ShapeProps, ShapeType } from '@whiteboard/shared';
import { Rng } from './random';

const CLIENTS = 5;
const ROUNDS = 1000;
const SEEDS = Number(process.env.CONVERGENCE_SEEDS ?? 50);
/** The whole run must finish in this (500 seeds take ~12 s on a dev machine). */
const DEADLINE_MS = Number(process.env.CONVERGENCE_DEADLINE_MS ?? 120_000);
const ONLY_SEED = process.env.CONVERGENCE_SEED;

const TYPES: ShapeType[] = ['rect', 'ellipse', 'arrow', 'stroke', 'note'];
// Small value ranges so concurrent writes often collide on the same value and property.
const COLORS = ['red', 'green', 'blue'];

interface StrokeState {
  nextChunk: number;
  sent: number[];
  finalized: boolean;
}

interface SimClient {
  clientId: string;
  clock: LamportClock;
  nextId: () => ShapeId;
  board: Board;
  opCount: number;
  /** Strokes this client authored. Only the author appends (CLAUDE.md rule 2). */
  strokes: Map<ShapeId, StrokeState>;
}

interface Stats {
  buffered: number;
  updatesOnTombstones: number;
  lateAppendsAfterFinalize: number;
  duplicates: number;
}

function randomPoints(rng: Rng): number[] {
  const pairs = 1 + rng.int(3);
  const pts: number[] = [];
  for (let i = 0; i < pairs; i++) pts.push(rng.int(100), rng.int(100));
  return pts;
}

/** A z key at a random position among the z keys this client currently knows. */
function randomZ(rng: Rng, board: Board): string {
  const zs = [...new Set(board.ids().map((id) => board.prop(id, 'z') ?? ''))].filter(Boolean).sort();
  const i = rng.int(zs.length + 1);
  return keyBetween(zs[i - 1] ?? '', zs[i] ?? '');
}

/** One user action, as the batch of ops the client would send together. */
function makeBatch(rng: Rng, c: SimClient): Op[] {
  const stamp = c.clock.tick();
  const opId = `${c.clientId}:${++c.opCount}`;
  const ids = c.board.ids();
  const open = [...c.strokes].filter(([, s]) => !s.finalized).map(([id]) => id);
  const r = rng.next();

  if (ids.length === 0 || r < 0.08) {
    const type = rng.pick(TYPES);
    const id = c.nextId();
    const create: Op = {
      kind: 'create',
      opId,
      stamp,
      // Strokes are created without `points`, which only the pen-up update writes.
      shape: {
        id,
        type,
        x: rng.int(10),
        y: rng.int(10),
        w: 1 + rng.int(5),
        h: 1 + rng.int(5),
        color: rng.pick(COLORS),
        z: randomZ(rng, c.board),
        ...(type === 'note' ? { text: 'hello' } : {}),
      },
    };
    if (type !== 'stroke') return [create];
    // Pen down: the first point goes in chunk 0, in the same batch as the create.
    const first = [rng.int(100), rng.int(100)];
    c.strokes.set(id, { nextChunk: 1, sent: [...first], finalized: false });
    const chunk0: Op = { kind: 'append', opId: `${c.clientId}:${++c.opCount}`, stamp: c.clock.tick(), id, chunk: 0, points: first };
    return [create, chunk0];
  }

  if (open.length > 0 && r < 0.25) {
    const id = rng.pick(open);
    const s = c.strokes.get(id) as StrokeState;
    const points = randomPoints(rng);
    s.sent.push(...points);
    return [{ kind: 'append', opId, stamp, id, chunk: s.nextChunk++, points }];
  }

  if (open.length > 0 && r < 0.32) {
    const id = rng.pick(open);
    const s = c.strokes.get(id) as StrokeState;
    s.finalized = true;
    // Stand-in for RDP: keep every other point pair. Content doesn't matter here, only merging.
    const simplified = s.sent.filter((_, i) => i % 4 < 2);
    return [{ kind: 'update', opId, stamp, id, props: { points: simplified } }];
  }

  // Target recently seen shapes half the time so edits pile up on the same few shapes.
  const id = rng.chance(0.5) ? rng.pick(ids.slice(-6)) : rng.pick(ids);
  const k = rng.next();
  let props: Partial<ShapeProps>;
  if (k < 0.3) props = { x: rng.int(10), y: rng.int(10) };
  else if (k < 0.45) props = rng.chance(0.5) ? { color: rng.pick(COLORS) } : { text: rng.pick(['a', 'b', 'c']) };
  else if (k < 0.6) props = { deleted: true };
  else if (k < 0.7) props = { deleted: false }; // undo of a delete
  else if (k < 0.85) props = { z: randomZ(rng, c.board) };
  else props = { w: 1 + rng.int(5), h: 1 + rng.int(5), color: rng.pick(COLORS) };
  return [{ kind: 'update', opId, stamp, id, props }];
}

function deliver(c: SimClient, op: Op, stats: Stats): void {
  if (op.kind !== 'create') {
    if (c.board.has(op.id) && !c.board.isVisible(op.id) && op.kind === 'update') stats.updatesOnTombstones++;
    if (op.kind === 'append' && c.board.prop(op.id, 'points') !== undefined) stats.lateAppendsAfterFinalize++;
  }
  c.clock.observe(op.stamp);
  if (!c.board.apply(op)) stats.buffered++;
}

function simulate(seed: number, stats: Stats): { clients: SimClient[]; log: Op[] } {
  const rng = new Rng(seed);
  const clients: SimClient[] = Array.from({ length: CLIENTS }, (_, i) => {
    const clientId = `c${i}`;
    return {
      clientId,
      clock: new LamportClock(clientId),
      nextId: createIdGenerator(clientId),
      board: new Board(),
      opCount: 0,
      strokes: new Map(),
    };
  });
  // A message is one batch; the server relays batches whole, so its ops arrive together.
  const inFlight: { to: number; ops: Op[] }[] = [];
  const log: Op[] = [];

  const deliverRandom = (allowRedelivery: boolean) => {
    const i = rng.int(inFlight.length);
    const msg = inFlight[i] as { to: number; ops: Op[] };
    // Swap-remove: picking a random index each time gives random order and random delays.
    inFlight[i] = inFlight[inFlight.length - 1] as { to: number; ops: Op[] };
    inFlight.pop();
    for (const op of msg.ops) deliver(clients[msg.to] as SimClient, op, stats);
    if (allowRedelivery && rng.chance(0.05)) {
      inFlight.push(msg); // e.g. resent after a lost ack
      stats.duplicates++;
    }
  };

  for (let round = 0; round < ROUNDS; round++) {
    const from = rng.int(CLIENTS);
    const author = clients[from] as SimClient;
    const ops = makeBatch(rng, author);
    for (const op of ops) author.board.apply(op); // optimistic local apply
    log.push(...ops);
    for (let to = 0; to < CLIENTS; to++) {
      if (to !== from) inFlight.push({ to, ops });
      if (rng.chance(to === from ? 0.03 : 0.1)) {
        inFlight.push({ to, ops }); // duplicate, including echoes back to the author
        stats.duplicates++;
      }
    }
    // About as many deliveries as messages produced, so the backlog (the "delay") varies.
    const n = rng.int(10);
    for (let k = 0; k < n && inFlight.length > 0; k++) deliverRandom(true);
  }
  while (inFlight.length > 0) deliverRandom(false);
  return { clients, log };
}

const newStats = (): Stats => ({ buffered: 0, updatesOnTombstones: 0, lateAppendsAfterFinalize: 0, duplicates: 0 });

describe('convergence', () => {
  it(`${CLIENTS} clients x ${ROUNDS} random ops converge for ${ONLY_SEED ? `seed ${ONLY_SEED}` : `${SEEDS} seeds`}`, () => {
    const seeds = ONLY_SEED ? [Number(ONLY_SEED)] : Array.from({ length: SEEDS }, (_, i) => i + 1);
    const stats = newStats();
    const started = performance.now();
    for (const seed of seeds) {
      // Vitest's timeout can't interrupt a synchronous loop (it only reports after the loop
      // ends), so check our own deadline between seeds: a stall fails within one seed of it.
      if (performance.now() - started > DEADLINE_MS) {
        throw new Error(`convergence run exceeded ${DEADLINE_MS / 1000} s at seed ${seed} of ${seeds.length} (stalled or too slow)`);
      }
      const { clients } = simulate(seed, stats);
      const reference = (clients[0] as SimClient).board.snapshot();
      const referenceJson = JSON.stringify(reference);
      for (const c of clients) {
        expect(c.board.bufferedCount, `seed ${seed}: ${c.clientId} still has buffered ops`).toBe(0);
        // snapshot() is canonical, so string equality is exact and much faster than toEqual
        // over 500 seeds. toEqual only runs on a mismatch, to print a readable diff.
        const snap = c.board.snapshot();
        if (JSON.stringify(snap) !== referenceJson) {
          expect(snap, `seed ${seed}: ${c.clientId} diverged from c0`).toEqual(reference);
          throw new Error(`seed ${seed}: ${c.clientId} snapshot differs from c0 only in serialization`);
        }
      }
    }
    // Guard against a test that passes trivially: the tricky paths must actually be exercised.
    if (!ONLY_SEED) {
      expect(stats.buffered, 'ops arriving before their create').toBeGreaterThan(0);
      expect(stats.updatesOnTombstones, 'updates landing on tombstones').toBeGreaterThan(0);
      expect(stats.lateAppendsAfterFinalize, 'appends arriving after pen-up').toBeGreaterThan(0);
      expect(stats.duplicates, 'duplicate deliveries').toBeGreaterThan(0);
    }
  }, DEADLINE_MS + 10_000);

  it('the same op log applied in any order, with duplicates, gives the same board', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { log } = simulate(seed, newStats());
      const rng = new Rng(seed * 7919);
      let reference: ReturnType<Board['snapshot']> | undefined;
      for (let trial = 0; trial < 10; trial++) {
        const ops = rng.shuffle([...log, ...log.filter(() => rng.chance(0.2))]);
        const board = new Board();
        ops.forEach((op) => board.apply(op));
        const snap = board.snapshot();
        if (reference) expect(snap, `seed ${seed}, trial ${trial}`).toEqual(reference);
        else reference = snap;
      }
    }
  });
});
