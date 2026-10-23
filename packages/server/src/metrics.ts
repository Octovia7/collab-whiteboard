import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const MS_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

/**
 * The metrics from system-design.md ("Metrics"), in Prometheus format on GET /metrics.
 * `ops_per_second` is exposed the Prometheus way, as the counter `ops_accepted_total`
 * (rate it in the dashboard). `catchup_ops` arrives with lastSeq catch-up in milestone 7.
 */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry }); // process CPU, memory, event loop lag, GC
  return {
    registry,
    opRelayMs: new Histogram({ name: 'op_relay_ms', help: 'Server receive -> peers sent (ms)', buckets: MS_BUCKETS, registers: [registry] }),
    opCommitMs: new Histogram({ name: 'op_commit_ms', help: 'Server receive -> Postgres commit -> ack (ms)', buckets: MS_BUCKETS, registers: [registry] }),
    opsAccepted: new Counter({ name: 'ops_accepted_total', help: 'Ops accepted into a board', registers: [registry] }),
    opsRejected: new Counter({ name: 'ops_rejected_total', help: 'Ops rejected', labelNames: ['reason'], registers: [registry] }),
    wsConnections: new Gauge({ name: 'ws_connections', help: 'Open WebSocket connections', registers: [registry] }),
    roomsLoaded: new Gauge({ name: 'rooms_loaded', help: 'Boards loaded in memory', registers: [registry] }),
    snapshotMs: new Histogram({ name: 'snapshot_ms', help: 'Time to write a snapshot (ms)', buckets: MS_BUCKETS, registers: [registry] }),
    boardLoadMs: new Histogram({ name: 'board_load_ms', help: 'Time to load a board from Postgres (ms)', buckets: MS_BUCKETS, registers: [registry] }),
    presenceMessages: new Counter({ name: 'presence_messages_total', help: 'Cursor and selection messages relayed', labelNames: ['type'], registers: [registry] }),
    heartbeatTimeouts: new Counter({ name: 'heartbeat_timeouts_total', help: 'Sockets dropped for missing heartbeats', registers: [registry] }),
    wsThrottled: new Counter({ name: 'ws_throttled_total', help: 'Op batches delayed by the per-user rate limit', registers: [registry] }),
    wsRateLimitDisconnects: new Counter({ name: 'ws_rate_limit_disconnects_total', help: 'Sockets closed for exceeding rate limits', registers: [registry] }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
