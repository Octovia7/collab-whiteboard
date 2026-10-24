/**
 * Shared helpers for the benchmarks in scripts/bench (load.ts, chaos.ts). They run against the
 * production stack from docker-compose.prod.yml: nginx on APP_PORT in front of two server
 * replicas. Only non-secret settings are read from .env.prod.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE = ['compose', '-f', resolve(ROOT, 'docker-compose.prod.yml'), '--env-file', resolve(ROOT, '.env.prod')];

function envProd(key: string): string | undefined {
  const line = readFileSync(resolve(ROOT, '.env.prod'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim();
}

export const APP_PORT = envProd('APP_PORT') ?? '8080';
export const BASE = `http://localhost:${APP_PORT}`;
export const WS_BASE = `ws://localhost:${APP_PORT}`;
/** The upgrade's Origin must be one the servers allow. */
export const ORIGIN = envProd('APP_ORIGIN') ?? BASE;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wall-clock ms with sub-ms precision, comparable across processes on this machine. */
export const nowMs = () => performance.timeOrigin + performance.now();

export async function api<T>(method: string, path: string, cookie?: string, body?: unknown): Promise<{ status: number; data: T; cookie?: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie().find((c) => c.startsWith('wb_session='));
  const data = (res.status === 204 ? null : await res.json().catch(() => null)) as T;
  return { status: res.status, data, cookie: set?.split(';')[0] };
}

/** Signs up a fresh user; returns its session cookie. */
export async function signUp(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@bench.test`;
  const res = await api<{ user: { id: string } }>('POST', '/api/auth/signup', undefined, { email, name: label, password: 'bench-password-123' });
  if (res.status === 201 && res.cookie) return { cookie: res.cookie, userId: res.data.user.id };
  if (res.status === 429) throw new Error('signup rate-limited: start the stack with AUTH_RATE_LIMIT_PER_MIN=1000 (see docs/benchmarks.md)');
  throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.data)}`);
}

/** A board owned by `cookie`, with an editor share link; returns the board id and link token. */
export async function boardWithLink(cookie: string, title: string): Promise<{ boardId: string; token: string }> {
  const board = await api<{ board: { id: string } }>('POST', '/api/boards', cookie, { title });
  if (board.status !== 201) throw new Error(`create board failed: ${board.status}`);
  const link = await api<{ link: { token: string } }>('PUT', `/api/boards/${board.data.board.id}/link`, cookie, { role: 'editor' });
  if (link.status !== 200) throw new Error(`link failed: ${link.status}`);
  return { boardId: board.data.board.id, token: link.data.link.token };
}

export async function join(cookie: string, token: string): Promise<void> {
  const res = await api('POST', `/api/join/${token}`, cookie);
  if (res.status !== 200) throw new Error(`join failed: ${res.status}`);
}

// ---- docker ----

export const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
export const compose = (...args: string[]) => docker(...COMPOSE, ...args);

/** Container ids of the server replicas, in a stable order. */
export function serverContainers(): string[] {
  return compose('ps', '-q', 'server').split(/\r?\n/).filter(Boolean).sort();
}

export function containerName(id: string): string {
  return docker('inspect', id, '--format', '{{.Name}}').replace(/^\//, '');
}

/**
 * Which replica each connection landed on: every server logs "socket opened" with the
 * connection's id, which is also the peerId it sends in `welcome`. Returns peerId -> index
 * into `containers`.
 */
export function replicaOfPeers(containers: string[], since?: string): Map<string, number> {
  const map = new Map<string, number>();
  containers.forEach((id, i) => {
    const logs = docker('logs', ...(since ? ['--since', since] : []), id);
    for (const line of logs.split(/\r?\n/)) {
      if (!line.includes('"socket opened"')) continue;
      const m = /"connId":"([0-9a-f-]{36})"/.exec(line);
      if (m?.[1]) map.set(m[1], i);
    }
  });
  return map;
}

/** One `docker stats` sample: CPU % (100 = one core) and memory MB per container name. */
export function dockerStats(): Record<string, { cpu: number; memMb: number }> {
  const out = docker('stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}');
  const stats: Record<string, { cpu: number; memMb: number }> = {};
  for (const line of out.split(/\r?\n/)) {
    const [name, cpu, mem] = line.split('\t');
    if (!name?.startsWith('whiteboard-prod-') || !cpu || !mem) continue;
    const used = mem.split('/')[0]?.trim() ?? '0';
    const n = parseFloat(used);
    const mb = used.endsWith('GiB') ? n * 1024 : used.endsWith('KiB') ? n / 1024 : n;
    stats[name.replace('whiteboard-prod-', '')] = { cpu: parseFloat(cpu), memMb: Math.round(mb) };
  }
  return stats;
}

// ---- latency histogram ----

/**
 * Fixed buckets, mergeable across worker processes: 0.1 ms wide up to 1 s, then 10 ms wide up
 * to 60 s. Percentiles are accurate to the bucket width, plenty for p50/p95/p99 in ms.
 */
export class Histogram {
  static readonly FINE = 10_000; // 0..1000 ms in 0.1 ms
  static readonly COARSE = 5_900; // 1000..60000 ms in 10 ms
  readonly counts: number[];
  count = 0;
  max = 0;

  constructor(counts?: number[]) {
    this.counts = counts ?? new Array<number>(Histogram.FINE + Histogram.COARSE + 1).fill(0);
    if (counts) for (const c of counts) this.count += c;
  }

  add(ms: number): void {
    const v = Math.max(0, ms);
    const i = v < 1000 ? Math.floor(v * 10) : Math.min(Histogram.FINE + Math.floor((v - 1000) / 10), this.counts.length - 1);
    this.counts[i] = (this.counts[i] ?? 0) + 1;
    this.count++;
    if (v > this.max) this.max = v;
  }

  merge(other: { counts: number[]; max: number }): void {
    other.counts.forEach((c, i) => {
      if (c) this.counts[i] = (this.counts[i] ?? 0) + c;
      this.count += c;
    });
    this.max = Math.max(this.max, other.max);
  }

  percentile(p: number): number {
    if (this.count === 0) return NaN;
    const target = Math.ceil((p / 100) * this.count);
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      seen += this.counts[i] ?? 0;
      // Report the bucket's upper edge: never better than the truth.
      if (seen >= target) return i < Histogram.FINE ? (i + 1) / 10 : 1000 + (i - Histogram.FINE + 1) * 10;
    }
    return this.max;
  }
}
