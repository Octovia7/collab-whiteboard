import type { PeerInfo } from '@whiteboard/shared';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Shared state that lives in Redis so every server sees the same thing (system-design.md,
 * "Redis keys"): seq counters, the snapshot lock, rate limits, socket caps, the online list
 * and revoked sessions. Every call goes through the shared connection, which has a command
 * timeout; callers decide whether a Redis failure fails open or closed.
 */

/** A Lua script run by its SHA (EVALSHA), loaded on first use or after a Redis restart. */
class LuaScript {
  private readonly sha: string;

  constructor(private readonly source: string) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  async run(redis: Redis, keys: string[], args: (string | number)[]): Promise<unknown> {
    try {
      return await redis.evalsha(this.sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('NOSCRIPT')) throw err;
      return redis.eval(this.source, keys.length, ...keys, ...args);
    }
  }
}

// ---- seq counters ----

/**
 * INCRBY with a floor: the counter is first raised to `floor` (the highest seq the room has
 * seen) if it's below it. A counter lost in a Redis restart (or never set) then can't hand out
 * a seq that's already in use; without the floor it would restart at 1.
 */
const RESERVE = new LuaScript(`
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local floor = tonumber(ARGV[2])
if cur < floor then redis.call('SET', KEYS[1], floor) end
return redis.call('INCRBY', KEYS[1], ARGV[1])
`);

/** Reserves `n` consecutive seqs for a board; returns the last one. */
export async function reserveSeqs(redis: Redis, boardId: string, n: number, floor: number): Promise<number> {
  return Number(await RESERVE.run(redis, [`seq:${boardId}`], [n, floor]));
}

/** The highest seq handed out for a board (0 if none). */
export async function readSeq(redis: Redis, boardId: string): Promise<number> {
  return Number((await redis.get(`seq:${boardId}`)) ?? 0);
}

// ---- snapshot lock ----

const UNLOCK = new LuaScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`);

/**
 * `snap-lock:{boardId}`: one server snapshots a board at a time. Expires on its own after
 * `ttlMs`, so a crashed holder can't block snapshots forever. Returns a release function, or
 * null if another server holds it. Release only deletes the lock if we still hold it.
 */
export async function acquireSnapshotLock(redis: Redis, boardId: string, holder: string, ttlMs = 30_000): Promise<(() => Promise<void>) | null> {
  const key = `snap-lock:${boardId}`;
  const ok = await redis.set(key, holder, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  return async () => {
    await UNLOCK.run(redis, [key], [holder]);
  };
}

// ---- op rate limit (token bucket per user, across servers) ----

/**
 * The same token bucket as TokenBucket in ws/rateLimit.ts, kept in a Redis hash so all of a
 * user's sockets on all servers draw from one budget. Uses Redis's clock, so servers with
 * slightly different clocks agree. Returns 0 if the tokens were taken, else the ms to wait.
 */
const TAKE = new LuaScript(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local perSec = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local n = tonumber(ARGV[3])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(b[1]) or burst
local at = tonumber(b[2]) or now
tokens = math.min(burst, tokens + math.max(0, now - at) / 1000 * perSec)
local wait = 0
if tokens >= n then tokens = tokens - n else wait = math.ceil((n - tokens) / perSec * 1000) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], 60000)
return wait
`);

export async function takeOpTokens(redis: Redis, userId: string, n: number, perSec: number, burst: number): Promise<number> {
  return Number(await TAKE.run(redis, [`rl:ws:${userId}`], [perSec, burst, n]));
}

// ---- open sockets per user (across servers) ----

/**
 * `sockets:{userId}`: connId -> expiry (epoch ms). Expired entries (their server stopped
 * refreshing them: it crashed) are dropped before counting. 1 if the socket may open.
 */
const OPEN_SOCKET = new LuaScript(`
local now = tonumber(ARGV[4])
local all = redis.call('HGETALL', KEYS[1])
local live = 0
for i = 1, #all, 2 do
  if tonumber(all[i + 1]) < now then redis.call('HDEL', KEYS[1], all[i]) else live = live + 1 end
end
if live >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], tostring(now + tonumber(ARGV[3])))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
return 1
`);

export async function openSocket(redis: Redis, userId: string, connId: string, max: number, ttlMs: number): Promise<boolean> {
  return Number(await OPEN_SOCKET.run(redis, [`sockets:${userId}`], [connId, max, ttlMs, Date.now()])) === 1;
}

export async function closeSocket(redis: Redis, userId: string, connId: string): Promise<void> {
  await redis.hdel(`sockets:${userId}`, connId);
}

/** Keeps this server's sockets counted (every sweep); one round trip for all of them. */
export async function refreshSockets(redis: Redis, sockets: { userId: string; connId: string }[], ttlMs: number): Promise<void> {
  if (sockets.length === 0) return;
  const expiry = String(Date.now() + ttlMs);
  const pipe = redis.pipeline();
  for (const s of sockets) {
    pipe.hset(`sockets:${s.userId}`, s.connId, expiry);
    pipe.pexpire(`sockets:${s.userId}`, ttlMs * 2);
  }
  await pipe.exec();
}

// ---- online list (presence across servers) ----

export interface OnlineEntry extends PeerInfo {
  serverId: string;
  /** Epoch ms this entry was last refreshed by its server. */
  lastSeen: number;
}

const onlineKey = (boardId: string) => `online:${boardId}`;

/** Adds or refreshes this server's peers in a board's online list. */
export async function putOnline(redis: Redis, boardId: string, peers: PeerInfo[], serverId: string): Promise<void> {
  if (peers.length === 0) return;
  const now = Date.now();
  const fields: string[] = [];
  for (const p of peers) fields.push(p.peerId, JSON.stringify({ ...p, serverId, lastSeen: now } satisfies OnlineEntry));
  await redis.hset(onlineKey(boardId), ...fields);
}

/** Removes a peer; true if it was there (so only one server announces its leave). */
export async function removeOnline(redis: Redis, boardId: string, peerId: string): Promise<boolean> {
  return (await redis.hdel(onlineKey(boardId), peerId)) === 1;
}

/** Everyone in a board's online list (stale entries included: the sweep removes them). */
export async function listOnline(redis: Redis, boardId: string): Promise<OnlineEntry[]> {
  const all = await redis.hgetall(onlineKey(boardId));
  const entries: OnlineEntry[] = [];
  for (const raw of Object.values(all)) {
    try {
      entries.push(JSON.parse(raw) as OnlineEntry);
    } catch {
      // A malformed entry can't come from us; ignore it (the sweep can't parse it either).
    }
  }
  return entries;
}

// ---- revoked sessions ----

/** Marks a session (JWT id) as logged out until the token would have expired anyway. */
export async function revokeSession(redis: Redis, jti: string, ttlMs: number): Promise<void> {
  await redis.set(`revoked:${jti}`, '1', 'PX', Math.max(1000, ttlMs));
}

/** Throws if Redis is unreachable: callers fail closed. */
export async function isRevoked(redis: Redis, jti: string): Promise<boolean> {
  return (await redis.exists(`revoked:${jti}`)) === 1;
}
