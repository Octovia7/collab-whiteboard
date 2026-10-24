/**
 * Chaos tests under load (docs/benchmarks.md), against the production stack: BOTS clients
 * (real SyncClients, the browser's sync code, in Node) on one board through nginx, while we
 *
 *   1. kill one server replica (SIGKILL): its clients reconnect to the other one;
 *   2. restart Redis: sync recovers, and seqs never collide;
 *   3. empty Redis (FLUSHALL, the seq counters are gone): the seq floor keeps seqs unique;
 *   4. pause Postgres for 40 s: "Saving paused" reaches the clients, then everything is saved.
 *
 * Every bot moves its own shape every 200 ms and sends a cursor every 50 ms (the load), and
 * every second creates a small marker shape. Creates are never overwritten, so they make "no
 * acked op lost" checkable at the end even though snapshots prune the op log: every marker
 * whose create was acked must be on the board a fresh client loads, and every bot's shape
 * must hold the last value it sent. Acks are read off each bot's socket.
 *
 *   pnpm bench:chaos   (stack started with AUTH_RATE_LIMIT_PER_MIN=1000; see docs/benchmarks.md)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import { BoardStore } from '../../packages/client/src/store/BoardStore';
import { Presence } from '../../packages/client/src/store/Presence';
import { SyncClient } from '../../packages/client/src/sync/SyncClient';
import { boardWithLink, compose, containerName, docker, join, ORIGIN, replicaOfPeers, ROOT, serverContainers, signUp, sleep, WS_BASE } from './common';

const BOTS = Number(process.env.BOTS ?? 20);
const PG_PAUSE_MS = Number(process.env.PG_PAUSE_MS ?? 40_000);

interface Bot {
  index: number;
  store: BoardStore;
  sync: SyncClient;
  shapeId: string;
  lastSent: number;
  /** Marker creates: opId -> shape id. */
  markers: Map<string, string>;
  ackedMarkers: Set<string>;
  peerId: string;
  timers: ReturnType<typeof setInterval>[];
  savingPausedSeen: boolean;
  reconnects: number;
}

const ts = () => new Date().toISOString().slice(11, 23);
const log = (msg: string) => console.log(`${ts()} ${msg}`);

async function startBot(index: number, boardId: string, token: string): Promise<Bot> {
  const { cookie } = await signUp(`chaos${index}`);
  await join(cookie, token);
  const store = new BoardStore(`c${index}x${Math.random().toString(36).slice(2, 7)}`);
  const bot: Bot = {
    index,
    store,
    sync: undefined as unknown as SyncClient,
    shapeId: '',
    lastSent: 0,
    markers: new Map(),
    ackedMarkers: new Set(),
    peerId: '',
    timers: [],
    savingPausedSeen: false,
    reconnects: 0,
  };
  // The cookie and Origin a browser would send; acks and welcomes read off the socket.
  const Impl = class extends NodeWebSocket {
    constructor(url: string | URL) {
      super(url, { headers: { cookie, origin: ORIGIN } });
      this.on('message', (raw) => {
        const s = raw.toString();
        if (s.startsWith('{"t":"ack"')) {
          for (const id of (JSON.parse(s) as { opIds: string[] }).opIds) if (bot.markers.has(id)) bot.ackedMarkers.add(id);
        } else if (s.startsWith('{"t":"welcome"')) {
          bot.peerId = (JSON.parse(s) as { you: { peerId: string } }).you.peerId;
        }
      });
    }
  } as unknown as typeof WebSocket;
  const sync = new SyncClient(store, { url: `${WS_BASE}/ws?board=${boardId}`, boardId, WebSocketImpl: Impl, presence: new Presence() });
  bot.sync = sync;
  let connections = 0;
  sync.events.on('welcome', () => {
    if (++connections > 1) bot.reconnects++;
  });
  sync.events.on('saving', (paused) => {
    if (paused) bot.savingPausedSeen = true;
  });
  sync.start();
  for (let i = 0; sync.status !== 'connected'; i++) {
    if (i > 300) throw new Error(`bot ${index} did not connect`);
    await sleep(50);
  }
  const create = store.makeCreate({ type: 'rect', x: 0, y: index * 40, w: 30, h: 20, color: '#1e1e1e' });
  bot.shapeId = create.shape.id;
  store.submit([create]);
  let m = 0;
  bot.timers.push(
    setInterval(() => {
      bot.lastSent++;
      store.submit([store.makeUpdate(bot.shapeId, { x: bot.lastSent })]);
    }, 200),
    setInterval(() => sync.sendCursor(Math.random() * 1000, Math.random() * 800), 50),
    setInterval(() => {
      m++;
      const marker = store.makeCreate({ type: 'ellipse', x: 2000 + m * 5, y: index * 40, w: 4, h: 4, color: '#e03131' });
      bot.markers.set(marker.opId, marker.shape.id);
      store.submit([marker]);
    }, 1000),
  );
  return bot;
}

const statuses = (bots: Bot[]) => {
  const counts: Record<string, number> = {};
  for (const b of bots) counts[b.sync.status] = (counts[b.sync.status] ?? 0) + 1;
  return counts;
};

async function waitFor(what: string, cond: () => boolean, ms: number): Promise<number> {
  const started = performance.now();
  while (!cond()) {
    if (performance.now() - started > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(100);
  }
  return Math.round(performance.now() - started);
}

const containerOf = (service: string) => compose('ps', '-q', service).split(/\r?\n/).filter(Boolean)[0] ?? '';
const psql = (sql: string) => docker('exec', containerOf('postgres'), 'psql', '-U', 'whiteboard', '-d', 'whiteboard', '-tAc', sql);
const redisCli = (...args: string[]) => docker('exec', containerOf('redis'), 'redis-cli', ...args);

function healthy(id: string): boolean {
  try {
    return docker('inspect', id, '--format', '{{.State.Health.Status}}') === 'healthy';
  } catch {
    return false;
  }
}

/** Warnings the servers log when an op couldn't be stored because its seq was taken. */
function seqCollisionsLogged(since: string): number {
  let n = 0;
  for (const id of serverContainers()) n += (docker('logs', '--since', since, id).match(/seq already taken/g) ?? []).length;
  return n;
}

async function main(): Promise<void> {
  const startedIso = new Date().toISOString();
  const servers = serverContainers();
  if (servers.length !== 2) throw new Error('expected 2 server replicas: is the production stack up?');
  const owner = await signUp('chaos-owner');
  const { boardId, token } = await boardWithLink(owner.cookie, 'Chaos test');
  log(`starting ${BOTS} bots`);
  const bots: Bot[] = [];
  for (let i = 0; i < BOTS; i += 4) bots.push(...(await Promise.all(Array.from({ length: Math.min(4, BOTS - i) }, (_, k) => startBot(i + k, boardId, token)))));
  await sleep(5_000);
  const report: Record<string, unknown> = { startedAt: startedIso, bots: BOTS };

  // ---- 1. kill a replica ----
  {
    const byPeer = replicaOfPeers(servers, startedIso);
    const onReplica = (r: number) => bots.filter((b) => byPeer.get(b.peerId) === r);
    const victim = onReplica(0).length >= onReplica(1).length ? 0 : 1;
    const victimId = servers[victim] as string;
    const affected = onReplica(victim);
    log(`1. SIGKILL ${containerName(victimId)} (${affected.length} of ${BOTS} bots on it)`);
    const before = new Map(affected.map((b) => [b, b.reconnects]));
    const killedAt = performance.now();
    docker('kill', victimId);
    const reconnectMs = await waitFor('affected bots to reconnect', () => affected.every((b) => b.reconnects > (before.get(b) ?? 0) && b.sync.status === 'connected'), 60_000);
    log(`   all ${affected.length} affected bots reconnected in ${reconnectMs} ms; statuses ${JSON.stringify(statuses(bots))}`);
    // Docker doesn't apply the restart policy to a container stopped with `docker kill`: bring
    // it back by hand, as an orchestrator would.
    if (docker('inspect', victimId, '--format', '{{.State.Status}}') !== 'running') docker('start', victimId);
    await waitFor('the killed replica to be healthy again', () => healthy(victimId), 120_000);
    log(`   killed replica healthy again ${Math.round(performance.now() - killedAt)} ms after the kill`);
    report.killReplica = { affectedBots: affected.length, allReconnectedMs: reconnectMs };
  }
  await sleep(5_000);

  // ---- 2. restart Redis ----
  {
    const since = new Date().toISOString();
    log('2. docker restart redis');
    const t0 = performance.now();
    docker('restart', containerOf('redis'));
    const restartMs = Math.round(performance.now() - t0);
    const recoveredMs = await waitFor('every bot connected with nothing unacked older than now', () => bots.every((b) => b.sync.status === 'connected'), 120_000);
    await sleep(5_000);
    const pgMax = Number(psql(`select coalesce(max(seq), 0) from board_ops where board_id = '${boardId}'`));
    const counter = Number(redisCli('GET', `seq:${boardId}`) || 0);
    const collisions = seqCollisionsLogged(since);
    log(`   redis back in ${restartMs} ms; all bots connected ${recoveredMs} ms later; statuses ${JSON.stringify(statuses(bots))}`);
    log(`   seq counter ${counter} >= max seq in Postgres ${pgMax}: ${counter >= pgMax}; seq collisions logged: ${collisions}`);
    report.redisRestart = { restartMs, botsConnectedAfterMs: recoveredMs, counterAtLeastPgMax: counter >= pgMax, counter, pgMax, seqCollisionsLogged: collisions };
  }
  await sleep(5_000);

  // ---- 3. Redis loses everything (counters included) ----
  {
    const since = new Date().toISOString();
    const counterBefore = Number(redisCli('GET', `seq:${boardId}`) || 0);
    log(`3. redis FLUSHALL (seq counter was ${counterBefore})`);
    redisCli('FLUSHALL');
    await sleep(15_000);
    const pgMax = Number(psql(`select coalesce(max(seq), 0) from board_ops where board_id = '${boardId}'`));
    const counter = Number(redisCli('GET', `seq:${boardId}`) || 0);
    const collisions = seqCollisionsLogged(since);
    log(`   counter now ${counter} (restarted from the rooms' floor, not 1); max seq in Postgres ${pgMax}; seq collisions logged: ${collisions}; statuses ${JSON.stringify(statuses(bots))}`);
    report.redisFlush = { counterBefore, counterAfter: counter, pgMax, counterAtLeastPgMax: counter >= pgMax, seqCollisionsLogged: collisions };
  }
  await sleep(5_000);

  // ---- 4. pause Postgres ----
  {
    for (const b of bots) b.savingPausedSeen = false;
    log(`4. docker pause postgres for ${PG_PAUSE_MS / 1000} s`);
    docker('pause', containerOf('postgres'));
    const pausedAt = performance.now();
    let pausedSeenAfterMs = -1;
    while (performance.now() - pausedAt < PG_PAUSE_MS) {
      if (pausedSeenAfterMs < 0 && bots.some((b) => b.sync.savingPaused)) pausedSeenAfterMs = Math.round(performance.now() - pausedAt);
      await sleep(250);
    }
    const sawPaused = bots.filter((b) => b.savingPausedSeen).length;
    docker('unpause', containerOf('postgres'));
    log(`   "Saving paused" first shown after ${pausedSeenAfterMs} ms; ${sawPaused} of ${BOTS} bots saw it; unpaused`);
    const resumedMs = await waitFor('saving to resume on every bot', () => bots.every((b) => !b.sync.savingPaused && b.sync.status === 'connected'), 120_000);
    log(`   resumed on every bot ${resumedMs} ms after unpausing`);
    report.postgresPause = { pausedForMs: PG_PAUSE_MS, savingPausedShownAfterMs: pausedSeenAfterMs, botsThatSawIt: sawPaused, resumedAfterUnpauseMs: resumedMs };
  }

  // ---- verification ----
  log('stopping the load; waiting for every bot to have nothing unacked');
  for (const b of bots) for (const t of b.timers) clearInterval(t);
  const settleMs = await waitFor('every op acked', () => bots.every((b) => b.sync.unackedCount === 0), 120_000);
  await sleep(2_000);
  const verifier = await startVerifier(boardId, token);
  const missingMarkers: string[] = [];
  const wrongShapes: string[] = [];
  let ackedMarkers = 0;
  for (const b of bots) {
    for (const opId of b.ackedMarkers) {
      ackedMarkers++;
      const id = b.markers.get(opId) as string;
      if (!verifier.get(id)) missingMarkers.push(id);
    }
    const x = verifier.get(b.shapeId)?.x;
    if (x !== b.lastSent) wrongShapes.push(`${b.shapeId}: ${x} != ${b.lastSent}`);
  }
  // Every bot's own board agrees with the fresh load.
  const reference = verifier.snapshot();
  // Compared with sorted keys: a board loaded from a Postgres JSONB snapshot has the same values
  // with its object keys in a different order.
  const divergedBots = bots.filter((b) => canonical(b.store.snapshot()) !== canonical(reference));
  const diverged = divergedBots.length;
  const firstDiverged = divergedBots[0];
  if (firstDiverged) log(`   bot ${firstDiverged.index} differs from the fresh load: ${diffBoards(firstDiverged.store.snapshot(), reference).slice(0, 8).join('; ')}`);
  const collisionsTotal = seqCollisionsLogged(startedIso);
  log(`all acked after ${settleMs} ms. acked markers ${ackedMarkers}, missing ${missingMarkers.length}; bots' final values wrong ${wrongShapes.length}; boards diverged ${diverged}; seq collisions logged in total ${collisionsTotal}`);
  report.verification = { ackedMarkers, missingMarkers: missingMarkers.length, wrongFinalValues: wrongShapes, divergedBoards: diverged, seqCollisionsLogged: collisionsTotal, settleMs };

  for (const b of bots) b.sync.stop();
  const outDir = resolve(ROOT, 'docs/bench-results');
  mkdirSync(outDir, { recursive: true });
  const file = resolve(outDir, `chaos-${startedIso.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  log(`results: ${file}`);
  const ok = missingMarkers.length === 0 && wrongShapes.length === 0 && diverged === 0;
  log(ok ? 'PASS: no acked op lost, every board converged' : 'FAIL: see above');
  process.exit(ok ? 0 : 1);
}

type Snap = ReturnType<BoardStore['snapshot']>;

/** JSON with object keys sorted, so equal data always serializes the same way. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** Where two boards differ: missing shapes, and registers with different values or stamps. */
function diffBoards(a: Snap, b: Snap): string[] {
  const out: string[] = [];
  const byId = (s: Snap) => new Map(s.shapes.map((x) => [x.id, x]));
  const [ma, mb] = [byId(a), byId(b)];
  for (const id of new Set([...ma.keys(), ...mb.keys()])) {
    const x = ma.get(id);
    const y = mb.get(id);
    if (!x || !y) {
      out.push(`${id} only in ${x ? 'bot' : 'fresh load'}`);
      continue;
    }
    for (const key of new Set([...Object.keys(x.regs), ...Object.keys(y.regs)])) {
      const rx = canonical(x.regs[key as keyof typeof x.regs]);
      const ry = canonical(y.regs[key as keyof typeof y.regs]);
      if (rx !== ry) out.push(`${id}.${key}: bot ${rx} vs fresh ${ry}`);
    }
    if (canonical(x.chunks) !== canonical(y.chunks)) out.push(`${id}.chunks differ`);
  }
  return out.length > 0 ? out : ['same shapes and registers; serialization differs'];
}

/** A fresh client (snapshot load) that only reads the board. */
async function startVerifier(boardId: string, token: string): Promise<BoardStore> {
  const { cookie } = await signUp('verifier');
  await join(cookie, token);
  const store = new BoardStore('verifier');
  const Impl = class extends NodeWebSocket {
    constructor(url: string | URL) {
      super(url, { headers: { cookie, origin: ORIGIN } });
    }
  } as unknown as typeof WebSocket;
  const sync = new SyncClient(store, { url: `${WS_BASE}/ws?board=${boardId}`, boardId, WebSocketImpl: Impl });
  sync.start();
  await waitFor('the verifier to load the board', () => sync.status === 'connected', 30_000);
  await sleep(1_000);
  sync.stop();
  return store;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
