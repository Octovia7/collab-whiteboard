/** The Redis primitives behind milestone 8 (packages/server/src/redisState.ts), against real Redis. */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireSnapshotLock,
  closeSocket,
  isRevoked,
  listOnline,
  openSocket,
  putOnline,
  readSeq,
  removeOnline,
  reserveSeqs,
  revokeSession,
  takeOpTokens,
} from '../../packages/server/src/redisState';
import { UserLimits } from '../../packages/server/src/ws/rateLimit';
import { flushRedis, TEST_REDIS_URL } from './db';

let redis: Redis;
beforeAll(() => {
  redis = new Redis(TEST_REDIS_URL);
});
afterAll(() => redis.disconnect());
beforeEach(() => flushRedis(TEST_REDIS_URL));

const silentLog = { warn: () => {} } as unknown as ConstructorParameters<typeof UserLimits>[5];

describe('seq counters', () => {
  it('hands out consecutive ranges', async () => {
    expect(await reserveSeqs(redis, 'b', 3, 0)).toBe(3);
    expect(await reserveSeqs(redis, 'b', 2, 0)).toBe(5);
    expect(await readSeq(redis, 'b')).toBe(5);
  });

  it('never hands out a seq at or below the floor, even after the counter was lost', async () => {
    await reserveSeqs(redis, 'b', 10, 0);
    await redis.del('seq:b'); // Redis restarted without its data
    expect(await reserveSeqs(redis, 'b', 1, 10)).toBe(11);
  });
});

describe('snapshot lock', () => {
  it('is held by one server at a time, released only by its holder, and expires', async () => {
    const release = await acquireSnapshotLock(redis, 'b', 'server-a', 300);
    expect(release).not.toBeNull();
    expect(await acquireSnapshotLock(redis, 'b', 'server-b', 300)).toBeNull();
    await new Promise((r) => setTimeout(r, 400)); // the holder "crashed": the lock expires
    const releaseB = await acquireSnapshotLock(redis, 'b', 'server-b', 5000);
    expect(releaseB).not.toBeNull();
    await release?.(); // A's late release must not free B's lock
    expect(await acquireSnapshotLock(redis, 'b', 'server-c', 5000)).toBeNull();
    await releaseB?.();
    expect(await acquireSnapshotLock(redis, 'b', 'server-c', 5000)).not.toBeNull();
  });
});

describe('op budget and socket cap', () => {
  it('a token bucket shared by every caller', async () => {
    expect(await takeOpTokens(redis, 'u', 100, 100, 100)).toBe(0);
    const wait = await takeOpTokens(redis, 'u', 50, 100, 100);
    expect(wait).toBeGreaterThan(300); // ~500 ms of refill at 100/s
    expect(await takeOpTokens(redis, 'other', 100, 100, 100)).toBe(0);
  });

  it('UserLimits throttles instead of rejecting', async () => {
    const limits = new UserLimits(redis, 1000, 100, 5, 15_000, silentLog);
    let throttled = 0;
    const started = performance.now();
    await limits.waitForOps('u', 100, () => throttled++); // the burst
    await limits.waitForOps('u', 50, () => throttled++); // must wait ~50 ms
    expect(throttled).toBeGreaterThan(0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('caps open sockets, frees a slot on close, and forgets sockets whose server stopped refreshing them', async () => {
    expect(await openSocket(redis, 'u', 'c1', 2, 300)).toBe(true);
    expect(await openSocket(redis, 'u', 'c2', 2, 300)).toBe(true);
    expect(await openSocket(redis, 'u', 'c3', 2, 300)).toBe(false);
    await closeSocket(redis, 'u', 'c1');
    expect(await openSocket(redis, 'u', 'c3', 2, 300)).toBe(true);
    await new Promise((r) => setTimeout(r, 400)); // c2 and c3 expired: their server died
    expect(await openSocket(redis, 'u', 'c4', 2, 300)).toBe(true);
    expect(await openSocket(redis, 'u', 'c5', 2, 300)).toBe(true);
  });
});

describe('online list and sessions', () => {
  it('one entry per connection, removed once', async () => {
    await putOnline(redis, 'b', [{ peerId: 'p1', userId: 'u1', name: 'One' }, { peerId: 'p2', userId: 'u1', name: 'One' }], 's1');
    expect((await listOnline(redis, 'b')).map((e) => [e.peerId, e.userId, e.serverId]).sort()).toEqual([
      ['p1', 'u1', 's1'],
      ['p2', 'u1', 's1'],
    ]);
    expect(await removeOnline(redis, 'b', 'p1')).toBe(true);
    expect(await removeOnline(redis, 'b', 'p1')).toBe(false); // a second server's sweep doesn't announce it again
  });

  it('revoked sessions stay revoked until their token would have expired', async () => {
    expect(await isRevoked(redis, 'jti-1')).toBe(false);
    await revokeSession(redis, 'jti-1', 1000);
    expect(await isRevoked(redis, 'jti-1')).toBe(true);
    expect(await redis.pttl('revoked:jti-1')).toBeLessThanOrEqual(1000);
  });
});
