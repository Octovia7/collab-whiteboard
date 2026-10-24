/**
 * Load test (docs/benchmarks.md): bot clients on one board through nginx, against the
 * production stack (two server replicas). Ramps 10 / 20 / 30 / 50 / 100 bots (BOT_STEPS to
 * change). Each bot moves its own shape every 200 ms and sends a cursor every 50 ms.
 *
 * Latency is end-to-end: sender's send -> another bot's receipt of the relayed op, measured at
 * every receiving bot and split by whether sender and receiver are on the same replica (local
 * broadcast) or different ones (through Redis pub/sub). The send time travels inside the op
 * (`text: "<bot>:<ms>"`), so receivers in other processes can compute it; every process shares
 * this machine's clock.
 *
 * Bots run in WORKERS child processes (2 by default) so the generator isn't one event loop.
 * The ramp stops early, and says why, if free RAM drops below MIN_FREE_MB (500) or the stack
 * starts refusing, closing or rejecting: on this laptop that is the generator and the stack
 * running out of room together, not a server limit.
 *
 *   pnpm bench:load    (stack started with AUTH_RATE_LIMIT_PER_MIN=1000; see docs/benchmarks.md)
 */
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  boardWithLink,
  containerName,
  docker,
  dockerStats,
  Histogram,
  join,
  nowMs,
  ORIGIN,
  replicaOfPeers,
  ROOT,
  serverContainers,
  signUp,
  sleep,
  WS_BASE,
} from './common';

const STEPS = (process.env.BOT_STEPS ?? '10,20,30,50,100').split(',').map(Number);
const WORKERS = Number(process.env.WORKERS ?? 2);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 5_000);
const MEASURE_MS = Number(process.env.MEASURE_MS ?? 30_000);
const MIN_FREE_MB = Number(process.env.MIN_FREE_MB ?? 500);
const MOVE_MS = 200;
const CURSOR_MS = 50;

const freeMb = () => Math.round(freemem() / 1024 / 1024);

/** What the numbers ran on: this host, and the Docker engine's VM (on Windows/macOS it is a separate VM). */
function machine() {
  const cpu = cpus();
  let dockerVm: { cpus: number; memMb: number } | null = null;
  try {
    const [n, mem] = docker('info', '--format', '{{.NCPU}} {{.MemTotal}}').split(' ');
    dockerVm = { cpus: Number(n), memMb: Math.round(Number(mem) / 1024 / 1024) };
  } catch {
    // no Docker info: leave it out
  }
  return {
    host: hostname(),
    os: `${platform()} ${release()}`,
    cpuModel: cpu[0]?.model.trim() ?? 'unknown',
    logicalCpus: cpu.length,
    ramMb: Math.round(totalmem() / 1024 / 1024),
    dockerVm,
    node: process.version,
    githubRunner: process.env.GITHUB_ACTIONS === 'true' ? { name: process.env.RUNNER_NAME ?? '', os: process.env.RUNNER_OS ?? '', arch: process.env.RUNNER_ARCH ?? '' } : null,
  };
}

type HistData = { counts: number[]; max: number };
type Counters = { sent: number; acked: number; rejected: number; closed: number; saving: number; refused: number };
type ParentMsg =
  | { cmd: 'add'; indexes: number[]; token: string; boardId: string }
  | { cmd: 'map'; replicaOf: Record<number, number> }
  | { cmd: 'measure'; on: boolean }
  | { cmd: 'stop' };
type WorkerMsg =
  | { type: 'added'; bots: { index: number; peerId: string }[]; failed: string[]; closes: string[] }
  | ({ type: 'result'; same: HistData; cross: HistData; cpuMs: number; wallMs: number; rssMb: number; alive: number; closes: string[] } & Counters)
  | { type: 'error'; message: string };

// ===================================================================== worker

interface Bot {
  index: number;
  ws: WebSocket;
  peerId: string;
  replica: number;
  timers: ReturnType<typeof setInterval>[];
}

function runWorker(): void {
  const bots: Bot[] = [];
  let replicaOf = new Map<number, number>();
  let measuring = false;
  let same = new Histogram();
  let cross = new Histogram();
  const zero = (): Counters => ({ sent: 0, acked: 0, rejected: 0, closed: 0, saving: 0, refused: 0 });
  let counters = zero();
  let cpuStart = process.cpuUsage();
  let wallStart = performance.now();
  /** Every socket the stack closed since the start (code and reason), measuring or not. */
  const closes: string[] = [];
  let stopping = false;
  const send = (m: WorkerMsg) => process.send?.(m);

  async function addBot(index: number, token: string, boardId: string): Promise<Bot> {
    const { cookie } = await signUp(`bot${index}`);
    await join(cookie, token);
    const cid = `b${index}x${Math.random().toString(36).slice(2, 7)}`;
    const ws = new WebSocket(`${WS_BASE}/ws?board=${boardId}`, { headers: { cookie, origin: ORIGIN } });
    const bot: Bot = { index, ws, peerId: '', replica: -1, timers: [] };
    let t = 1;
    let n = 0;
    const shapeId = `${cid}-1`;
    const sendOps = (ops: unknown[]) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ops', ops }));

    await new Promise<void>((resolveBot, reject) => {
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) => {
        counters.refused++;
        reject(new Error(`upgrade refused: ${res.statusCode}`));
      });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', boardId, lastSeq: 0 })));
      ws.on('close', (code, reason) => {
        counters.closed++;
        if (!stopping) closes.push(`bot ${index}: ${code} ${reason.toString() || '(no reason)'}`);
        for (const timer of bot.timers) clearInterval(timer);
      });
      ws.on('message', (raw) => {
        const s = raw.toString();
        // Most traffic is other bots' cursors: skip them without parsing.
        if (s.startsWith('{"t":"cursor"')) return;
        const msg = JSON.parse(s) as { t: string; you?: { peerId: string }; ops?: { props?: { text?: string } }[]; opIds?: string[] };
        switch (msg.t) {
          case 'welcome':
            bot.peerId = msg.you?.peerId ?? '';
            // Our shape first, then the timers: a move every 200 ms, a cursor every 50 ms.
            sendOps([{ kind: 'create', opId: `${cid}:0`, stamp: { t: t++, client: cid }, shape: { id: shapeId, type: 'rect', x: 0, y: index * 40, w: 30, h: 20, color: '#1e1e1e', z: 'i0' } }]);
            bot.timers.push(
              setInterval(() => {
                n++;
                // The send time rides in the op, so any receiver can compute the latency.
                sendOps([{ kind: 'update', opId: `${cid}:${n}`, stamp: { t: t++, client: cid }, id: shapeId, props: { x: n % 1000, text: `${index}:${nowMs().toFixed(3)}` } }]);
                if (measuring) counters.sent++;
              }, MOVE_MS),
              setInterval(() => {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'cursor', x: Math.round(Math.random() * 1000), y: Math.round(Math.random() * 800) }));
              }, CURSOR_MS),
            );
            resolveBot();
            return;
          case 'ops': {
            if (!measuring) return;
            const at = nowMs();
            for (const op of msg.ops ?? []) {
              const m = /^(\d+):([\d.]+)$/.exec(op.props?.text ?? '');
              if (!m) continue;
              const from = replicaOf.get(Number(m[1]));
              if (from === undefined || bot.replica < 0) continue;
              (from === bot.replica ? same : cross).add(at - Number(m[2]));
            }
            return;
          }
          case 'ack':
            if (measuring) counters.acked += msg.opIds?.length ?? 0;
            return;
          case 'reject':
            counters.rejected++;
            return;
          case 'saving':
            counters.saving++;
            return;
          default:
            return;
        }
      });
    });
    return bot;
  }

  process.on('message', (m: ParentMsg) => {
    void (async () => {
      try {
        switch (m.cmd) {
          case 'add': {
            const added: Bot[] = [];
            const failed: string[] = [];
            // A few at a time: sign-ups are bcrypt cost 12 on the servers.
            for (let i = 0; i < m.indexes.length; i += 3) {
              const settled = await Promise.allSettled(m.indexes.slice(i, i + 3).map((idx) => addBot(idx, m.token, m.boardId)));
              for (const r of settled) {
                if (r.status === 'fulfilled') added.push(r.value);
                else failed.push((r.reason as Error).message);
              }
            }
            bots.push(...added);
            send({ type: 'added', bots: added.map((b) => ({ index: b.index, peerId: b.peerId })), failed, closes: [...closes] });
            return;
          }
          case 'map':
            replicaOf = new Map(Object.entries(m.replicaOf).map(([k, v]) => [Number(k), v]));
            for (const b of bots) b.replica = replicaOf.get(b.index) ?? -1;
            return;
          case 'measure':
            if (m.on) {
              same = new Histogram();
              cross = new Histogram();
              counters = zero();
              cpuStart = process.cpuUsage();
              wallStart = performance.now();
              measuring = true;
            } else {
              measuring = false;
              const cpu = process.cpuUsage(cpuStart);
              send({
                type: 'result',
                same: { counts: same.counts, max: same.max },
                cross: { counts: cross.counts, max: cross.max },
                ...counters,
                cpuMs: (cpu.user + cpu.system) / 1000,
                wallMs: performance.now() - wallStart,
                rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                alive: bots.filter((b) => b.ws.readyState === b.ws.OPEN).length,
                closes: [...closes],
              });
            }
            return;
          case 'stop':
            stopping = true;
            for (const b of bots) b.ws.close();
            setTimeout(() => process.exit(0), 500);
            return;
        }
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      }
    })();
  });
}

// ===================================================================== parent

type Lat = { n: number; p50: number; p95: number; p99: number; max: number };

interface StepResult {
  bots: number;
  perReplica: number[];
  same: Lat;
  cross: Lat;
  all: Lat;
  opsPerSec: { sent: number; acked: number; expected: number };
  deliveriesPerSec: number;
  problems: { rejected: number; closed: number; saving: number; refused: number; aliveAtEnd: number; closesSoFar: string[] };
  generator: { cpuPct: number; rssMb: number };
  hostFreeRamMb: { min: number; atStart: number };
  containers: Record<string, { cpuAvg: number; cpuMax: number; memMaxMb: number }>;
}

const summary = (h: Histogram): Lat => ({ n: h.count, p50: h.percentile(50), p95: h.percentile(95), p99: h.percentile(99), max: Math.round(h.max * 10) / 10 });

async function runParent(): Promise<void> {
  const startedIso = new Date().toISOString();
  const containers = serverContainers();
  if (containers.length !== 2) throw new Error(`expected 2 server replicas, found ${containers.length}: is the production stack up?`);
  console.log(`replicas: ${containers.map(containerName).join(', ')}; workers: ${WORKERS}; steps: ${STEPS.join(', ')}; free RAM ${freeMb()} MB of ${Math.round(totalmem() / 1024 / 1024)} MB`);

  const owner = await signUp('owner');
  const { boardId, token } = await boardWithLink(owner.cookie, 'Load test');
  const workers = Array.from({ length: WORKERS }, () =>
    fork(fileURLToPath(import.meta.url), ['--worker'], { execArgv: ['--import', 'tsx'], stdio: 'inherit' }),
  );
  const inbox = workers.map(() => [] as WorkerMsg[]);
  workers.forEach((w, i) =>
    w.on('message', (m: WorkerMsg) => {
      if (m.type === 'error') console.error(`worker ${i}: ${m.message}`);
      inbox[i]?.push(m);
    }),
  );
  const next = async <T extends WorkerMsg['type']>(i: number, type: T): Promise<Extract<WorkerMsg, { type: T }>> => {
    for (;;) {
      const box = inbox[i] as WorkerMsg[];
      const at = box.findIndex((m) => m.type === type || m.type === 'error');
      if (at >= 0) {
        const [m] = box.splice(at, 1);
        if (m?.type === 'error') throw new Error(`worker ${i}: ${m.message}`);
        return m as Extract<WorkerMsg, { type: T }>;
      }
      await sleep(20);
    }
  };

  const peerOf = new Map<number, string>();
  const results: StepResult[] = [];
  let stoppedEarly: string | null = null;
  let total = 0;
  for (const target of STEPS) {
    if (freeMb() < MIN_FREE_MB) {
      stoppedEarly = `before ${target} bots: free RAM ${freeMb()} MB < ${MIN_FREE_MB} MB`;
      break;
    }
    // Add bots up to `target`, spread over the workers.
    const indexes = Array.from({ length: target - total }, (_, k) => total + k);
    const perWorker = workers.map((_, wi) => indexes.filter((_, k) => k % WORKERS === wi));
    const connectStart = performance.now();
    perWorker.forEach((idx, wi) => workers[wi]?.send({ cmd: 'add', indexes: idx, token, boardId } satisfies ParentMsg));
    const failed: string[] = [];
    const closedWhileConnecting: string[] = [];
    for (let wi = 0; wi < WORKERS; wi++) {
      const added = await next(wi, 'added');
      for (const b of added.bots) peerOf.set(b.index, b.peerId);
      failed.push(...added.failed);
      closedWhileConnecting.push(...added.closes);
    }
    total = peerOf.size;
    console.log(`\n${total} bots connected (+${indexes.length - failed.length} in ${Math.round((performance.now() - connectStart) / 1000)} s)`);
    if (failed.length > 0) {
      stoppedEarly = `at ${target} bots: ${failed.length} bots could not connect (${[...new Set(failed)].join('; ')})`;
      break;
    }
    // A bot the stack closed (between steps too, e.g. while others were signing up) would make
    // the next measurement look lighter than it is: stop instead, and say why.
    if (closedWhileConnecting.length > 0) {
      stoppedEarly = `at ${target} bots: the stack closed ${closedWhileConnecting.length} sockets (${closedWhileConnecting.slice(0, 5).join('; ')})`;
      break;
    }

    // Which replica each bot landed on, from the servers' own logs.
    const byPeer = replicaOfPeers(containers, startedIso);
    const replicaOf: Record<number, number> = {};
    for (const [index, peerId] of peerOf) {
      const r = byPeer.get(peerId);
      if (r !== undefined) replicaOf[index] = r;
    }
    const perReplica = containers.map((_, r) => Object.values(replicaOf).filter((x) => x === r).length);
    if (Object.keys(replicaOf).length !== total) console.warn(`  could not place ${total - Object.keys(replicaOf).length} bots on a replica`);
    for (const w of workers) w.send({ cmd: 'map', replicaOf } satisfies ParentMsg);
    await sleep(SETTLE_MS);

    // Measure: latencies in the workers; docker stats and host RAM sampled here meanwhile.
    for (const w of workers) w.send({ cmd: 'measure', on: true } satisfies ParentMsg);
    const samples: Record<string, { cpu: number; memMb: number }>[] = [];
    const freeAtStart = freeMb();
    let freeMin = freeAtStart;
    const end = performance.now() + MEASURE_MS;
    while (performance.now() < end - 2500) {
      samples.push(dockerStats()); // each call takes ~2 s
      freeMin = Math.min(freeMin, freeMb());
    }
    await sleep(Math.max(0, end - performance.now()));
    freeMin = Math.min(freeMin, freeMb());
    for (const w of workers) w.send({ cmd: 'measure', on: false } satisfies ParentMsg);

    const same = new Histogram();
    const cross = new Histogram();
    const all = new Histogram();
    const c = { sent: 0, acked: 0, rejected: 0, closed: 0, saving: 0, refused: 0, cpuMs: 0, wallMs: 0, rssMb: 0, alive: 0 };
    const allCloses: string[] = [];
    for (let wi = 0; wi < WORKERS; wi++) {
      const r = await next(wi, 'result');
      same.merge(r.same);
      cross.merge(r.cross);
      all.merge(r.same);
      all.merge(r.cross);
      c.sent += r.sent;
      c.acked += r.acked;
      c.rejected += r.rejected;
      c.closed += r.closed;
      c.saving += r.saving;
      c.refused += r.refused;
      c.cpuMs += r.cpuMs;
      c.rssMb += r.rssMb;
      c.alive += r.alive;
      allCloses.push(...r.closes);
      c.wallMs = Math.max(c.wallMs, r.wallMs);
    }
    const secs = c.wallMs / 1000;
    const containersStats: StepResult['containers'] = {};
    for (const name of new Set(samples.flatMap((s) => Object.keys(s)))) {
      const series = samples.map((s) => s[name]).filter((x): x is { cpu: number; memMb: number } => !!x);
      containersStats[name] = {
        cpuAvg: Math.round(series.reduce((a, s) => a + s.cpu, 0) / Math.max(1, series.length)),
        cpuMax: Math.round(Math.max(...series.map((s) => s.cpu))),
        memMaxMb: Math.max(...series.map((s) => s.memMb)),
      };
    }
    const result: StepResult = {
      bots: total,
      perReplica,
      same: summary(same),
      cross: summary(cross),
      all: summary(all),
      opsPerSec: { sent: Math.round(c.sent / secs), acked: Math.round(c.acked / secs), expected: Math.round((total * 1000) / MOVE_MS) },
      deliveriesPerSec: Math.round(all.count / secs),
      problems: { rejected: c.rejected, closed: c.closed, saving: c.saving, refused: c.refused, aliveAtEnd: c.alive, closesSoFar: allCloses.slice(0, 20) },
      generator: { cpuPct: Math.round((c.cpuMs / c.wallMs) * 100), rssMb: c.rssMb },
      hostFreeRamMb: { min: freeMin, atStart: freeAtStart },
      containers: containersStats,
    };
    results.push(result);
    const fmt = (s: Lat) => `p50 ${s.p50} / p95 ${s.p95} / p99 ${s.p99} ms (n=${s.n})`;
    console.log(`  replicas ${perReplica.join(' + ')}; ops/s sent ${result.opsPerSec.sent}, acked ${result.opsPerSec.acked}; deliveries/s ${result.deliveriesPerSec}`);
    console.log(`  same-server  ${fmt(result.same)}`);
    console.log(`  cross-server ${fmt(result.cross)}`);
    console.log(`  all          ${fmt(result.all)}`);
    console.log(`  containers ${JSON.stringify(containersStats)}`);
    console.log(`  generator CPU ${result.generator.cpuPct}% (100 = one core), RSS ${result.generator.rssMb} MB; host free RAM min ${freeMin} MB`);

    const p = result.problems;
    if (p.rejected || p.closed || p.saving || p.refused || p.aliveAtEnd < total) {
      stoppedEarly = `after ${total} bots: the stack rejected ${p.rejected} ops, closed ${p.closed} sockets (${p.aliveAtEnd} of ${total} still open; ${p.closesSoFar.slice(0, 3).join('; ')}), refused ${p.refused}, sent saving ${p.saving}`;
      break;
    }
    if (freeMin < MIN_FREE_MB) {
      stoppedEarly = `after ${total} bots: free RAM fell to ${freeMin} MB (< ${MIN_FREE_MB} MB)`;
      break;
    }
  }

  for (const w of workers) w.send({ cmd: 'stop' } satisfies ParentMsg);
  const outDir = resolve(ROOT, 'docs/bench-results');
  mkdirSync(outDir, { recursive: true });
  const file = resolve(outDir, `load-${startedIso.replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { startedAt: startedIso, machine: machine(), workers: WORKERS, moveMs: MOVE_MS, cursorMs: CURSOR_MS, settleMs: SETTLE_MS, measureMs: MEASURE_MS, minFreeMb: MIN_FREE_MB, stoppedEarly, results },
      null,
      2,
    ),
  );
  const over = results.find((r) => r.all.p95 > 150);
  console.log(`\nresults: ${file}`);
  if (stoppedEarly) console.log(`ramp stopped early: ${stoppedEarly}`);
  console.log(over ? `p95 first above 150 ms at ${over.bots} bots` : 'p95 stayed at or below 150 ms at every step that ran');
  await sleep(1000);
  process.exit(0);
}

if (process.argv.includes('--worker')) runWorker();
else
  runParent().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
