# Benchmarks

Load and chaos tests of the production stack (`docker-compose.prod.yml`: two server replicas behind nginx, Postgres 16, Redis 7). Raw results are in [`docs/bench-results/`](bench-results/). Measured on 2026-10-24.

## Summary

- **One board, GitHub-hosted runner (2 vCPU, 8 GB), cursors batched:** p95 end-to-end latency stays under 150 ms up to **50 active editors**: p50 21 ms, p95 66 ms, p99 97 ms, with 248 ops/s acked and 12,100 op deliveries/s. Between 50 and 60 editors the runner runs out of CPU: at 60, p95 is 1.6 s.
- **Cursors were the main cost.** Relaying every cursor to every socket is O(n²) messages. Before batching, the same runner held p95 at 24 ms with 30 editors and fell over at 50 (p95 31.8 s, half the sockets closed). With cursors switched off, 50 editors had p95 35 ms. After the server started batching cursors (one message per socket every 50 ms), 50 editors had p95 66 ms.
- **Cross-server cost:** ops between replicas go through Redis pub/sub. At light load that adds about 1 ms at p50 (2.0 → 2.8 ms with 10 editors), and about 7 ms at 50 editors (17.9 → 24.5 ms).
- **Chaos tests passed under load.** These were run on the laptop with 10 editors, each also creating a marker shape every second:
  - Killing a replica: its clients reconnect to the other one in 2.7 s.
  - Restarting Redis, or wiping it entirely: no seq collisions.
  - Freezing Postgres for 40 s: "Saving paused" appears at 32 s and clears 0.2 s after Postgres is back.
  - Afterwards, every acked op is on the board (873 markers, 0 missing) and every client converged.
- **Three bugs found and fixed:**
  - nginx waited 60 s on a dead replica before trying the other.
  - A frozen Postgres never showed "Saving paused".
  - The cursor fan-out above.
- **One limit, not fixed:** past saturation, the overloaded replica closes sockets (1013) when its Redis calls time out. Those clients reconnect and add load.

**Read these as a lower bound, not server capacity.** On both machines, the load generator, both server replicas, nginx, Postgres and Redis all ran on the same host. On the runner that is 2 vCPUs for all of them. On the laptop it is one 6-core laptop with 5.8 GB of RAM, shared with the developer's other applications. Production would put the generator elsewhere and give each replica its own cores.

## Machines

| | GitHub-hosted runner (main numbers) | Development laptop (secondary) |
| --- | --- | --- |
| CPU | AMD EPYC 7763 (one run on an EPYC 9V74), **2 vCPUs** | AMD Ryzen 5 5500U, 6 cores / 12 threads, 2.1 GHz base |
| RAM | 7.9 GB | **5.8 GB** (about 0.6 GB free with the developer's apps open) |
| OS | Ubuntu (Azure VM, kernel 7.0), Docker native | Windows 11, Docker Desktop (WSL2 VM, about 2.8 GB) |
| Node | 22.23 | 22.20 |
| Power | n/a | mains (charger plugged in) |
| Ran there | load ramps (`.github/workflows/load-test.yml`, manual) | load ramp (stopped by low RAM), chaos test |

Hosted runners are shared VMs. The same code at 30 editors gave p95 24 ms in one run and 161 ms in an earlier one (`bench-results/superseded/github-run1-closes-not-tracked.json`), so treat small differences between runs as noise.

## Method

**Load test** (`pnpm bench:load`, [`scripts/bench/load.ts`](../scripts/bench/load.ts)):

- **Bots:** they sign up, join one board through its share link, and connect through nginx (`ws://localhost:8080/ws`), exactly like browsers. nginx spreads them over the two replicas.
- **Each bot's load:**
  - creates a shape, then moves it every 200 ms (5 ops/s), each op a real `update`;
  - sends a cursor every 50 ms (20/s, the browser client's throttle), unless `CURSOR_MS=0`.
- **Latency:** end to end, from a bot sending an op to every other bot receiving it relayed. The send time travels inside the op (`text: "<bot>:<ms>"`), so any receiving process can compute it against the shared machine clock. Every delivery is one sample; a 50-editor step yields about 360,000 samples.
- **Same-server vs cross-server:** each bot's replica comes from the servers' own `socket opened` log lines, matched by connection id. A pair on the same replica gets a local broadcast; a cross-replica pair goes through Redis pub/sub.
- **The ramp:** 10, 20, 30, 50 and 100 bots, added cumulatively. Each step settles for 5 s and is measured for 30 s.
- **What each step records:**
  - latency percentiles (from a histogram with 0.1 ms buckets below 1 s);
  - ops/s sent and acked, and deliveries/s;
  - `docker stats` CPU (100% = one core) and memory per container, sampled about every 2 s;
  - the generator's own CPU, and the host's free RAM.
- **Stop rules:** the ramp stops and records why if free RAM drops below 500 MB, or if the stack refuses, rejects or closes any socket at any point (also between steps).
- **Generator:** two worker processes, so it isn't one event loop.
- **On GitHub:** `gh workflow run load-test.yml` (inputs: steps, workers, measure window, cursor interval) builds the images, starts the stack and uploads the results JSON and the stack's logs.

**Chaos test** (`pnpm bench:chaos`, [`scripts/bench/chaos.ts`](../scripts/bench/chaos.ts)):

- **Bots:** 10 real `SyncClient`s, the browser's sync code. Each moves its shape every 200 ms, sends cursors at 20/s, and creates a small marker shape every second.
- **Checking for lost ops:** creates are never overwritten, so "every marker whose create was acked is still on the board" proves no acked op was lost, even though snapshots prune the op log. Acks are read off each bot's socket.
- **Faults injected, in order, under that load:**
  1. SIGKILL one replica, then start it again;
  2. `docker restart` Redis;
  3. `redis-cli FLUSHALL`, losing the seq counters;
  4. `docker pause` Postgres for 40 s.
- **Final check:** stop the load, wait until nothing is unacked, then load the board in a fresh client and compare it with every bot's board (keys sorted).

**Reproducing:**

```bash
# laptop (or any Docker host); the bots sign up, so raise the per-IP sign-up limit
AUTH_RATE_LIMIT_PER_MIN=1000 docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build --wait
pnpm bench:load        # BOT_STEPS, WORKERS, MEASURE_MS, CURSOR_MS, MIN_FREE_MB
pnpm bench:chaos       # BOTS, PG_PAUSE_MS
# GitHub runner
gh workflow run load-test.yml -f steps=10,20,30,50,100 -f cursor_ms=50
```

## Results: GitHub runner (main numbers)

Latencies in ms unless marked `s`. CPU is `docker stats` (100 = one core) averaged over the measurement window. RAM is the peak. The runner has 2 vCPUs, so all containers together can use at most 200.

### After batching cursors

`github/3-cursors-batched.json` (10–50 editors). The 100-editor step was not measured: the stack closed 42 sockets while the bots were joining (1013 `try_again_later`, Redis calls timing out on an overloaded replica).

| Editors | Split | p50 | p95 | p99 | Same-server p50 / p95 | Cross-server p50 / p95 | Ops/s sent / acked | Deliveries/s | Server CPU (each) | Server RAM MB (each) | nginx CPU | Redis CPU | Postgres CPU | Generator CPU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 6 + 4 | 2.4 | 5.6 | 9.1 | 2.0 / 4.7 | 2.8 / 6.1 | 50 / 50 | 449 | 10, 11 | 43, 58 | 4 | 3 | 3 | 9 |
| 20 | 10 + 10 | 3.1 | 7.6 | 13.4 | 2.4 / 6.1 | 3.6 / 8.6 | 100 / 100 | 1,898 | 15, 15 | 61, 64 | 9 | 4 | 3 | 14 |
| 30 | 15 + 15 | 3.8 | 12.1 | 25.4 | 3.0 / 10.1 | 4.6 / 13.8 | 150 / 150 | 4,339 | 21, 20 | 66, 66 | 15 | 6 | 4 | 23 |
| **50** | 27 + 23 | **21.2** | **65.9** | **96.9** | 17.9 / 58.8 | 24.5 / 71.1 | 247 / 248 | 12,141 | 33, 36 | 71, 70 | 27 | 8 | 7 | 38 |

`github/4-cursors-batched-50-to-90.json` (a second run, to find the crossing). It stopped after 90 editors, because the stack had closed 16 sockets (1013).

| Editors | Split | p50 | p95 | p99 | Ops/s sent / acked | Deliveries/s | Server CPU (each) | Server RAM MB (each) | nginx CPU | Generator CPU |
|---|---|---|---|---|---|---|---|---|---|---|
| 60 | 26 + 34 | 91 | **1.6 s** | 2.5 s | 293 / 310 | 18,107 | 34, 42 | 70, 71 | 29 | 38 |
| 70 | 31 + 39 | 2.6 s | 4.7 s | 5.0 s | 321 / 291 | 22,384 | 37, 41 | 77, 80 | 30 | 35 |
| 80 | 36 + 44 | 625 | 24.4 s | 24.9 s | 374 / 262 | 22,583 | 38, 40 | 83, 91 | 30 | 37 |
| 90 | 39 + 51 | 34.6 s | 42.5 s | 43.3 s | 348 / 261 | 22,193 | 39, 38 | 98, 132 | 30 | 37 |

**Where p95 crosses 150 ms: between 50 and 60 editors** on one board. Past that, acks fall behind sends (the op log can't keep up), and deliveries flatten at about 22,000/s, which is this runner's ceiling for the whole stack. Each container's CPU looks moderate, but they add up to about 150–160% of the runner's 200%. The rest goes to Docker's networking and the kernel, so the machine as a whole is saturated. These numbers don't show which component saturates first.

### Before batching cursors, and with cursors off

`github/1-cursors-unbatched.json`: every cursor relayed to every other socket. It stopped after 50 editors, because the stack had closed 24 sockets (1013).

| Editors | p50 | p95 | p99 | Same / cross p95 | Ops/s sent / acked | Deliveries/s | Server CPU (each) | nginx CPU |
|---|---|---|---|---|---|---|---|---|
| 10 | 1.7 | 5.1 | 11.2 | 4.7 / 5.5 | 50 / 50 | 448 | 12, 8 | 5 |
| 20 | 2.4 | 6.6 | 20.6 | 5.9 / 7.2 | 100 / 100 | 1,899 | 22, 15 | 14 |
| 30 | 4.9 | 24.1 | 48.6 | 22.6 / 25.4 | 150 / 150 | 4,347 | 35, 24 | 26 |
| 50 | 548 | **31.8 s** | 39.6 s | 29.2 s / 33.1 s | 238 / 155 | 6,564 | 48, 39 | 30 |

`github/2-cursors-off.json`: ops only (`CURSOR_MS=0`).

| Editors | p50 | p95 | p99 | Same / cross p95 | Ops/s sent / acked | Deliveries/s | Server CPU (each) | nginx CPU |
|---|---|---|---|---|---|---|---|---|
| 10 | 2.5 | 5.4 | 8.4 | 4.5 / 5.9 | 50 / 50 | 449 | 9, 8 | 2 |
| 20 | 2.3 | 5.2 | 9.2 | 4.3 / 5.8 | 100 / 100 | 1,899 | 10, 13 | 6 |
| 30 | 3.0 | 7.4 | 13.5 | 6.1 / 8.3 | 150 / 150 | 4,346 | 14, 17 | 12 |
| 50 | 9.1 | **35.2** | 61.2 | 31.5 / 38.5 | 249 / 249 | 12,208 | 27, 32 | 27 |
| 100 | 18.9 s | 53.9 s | 54.4 s | 53.8 s / 54.2 s | 476 / 204 | 25,661 | 39, 39 | 30 |

### Before / after at a glance (p95, ms)

| Editors | Cursors relayed one by one | Cursors batched | Cursors off |
|---|---|---|---|
| 10 | 5.1 | 5.6 | 5.4 |
| 20 | 6.6 | 7.6 | 5.2 |
| 30 | 24.1 | 12.1 | 7.4 |
| 50 | 31,800 (24 sockets closed) | 65.9 | 35.2 |
| 60 | not reached | 1,620 | not measured |
| 100 | not reached | stack closed sockets while bots joined | 53,900 |

Batching removes most of the cursor cost: at 50 editors, p95 falls from 31.8 s to 66 ms, against 35 ms with no cursors at all. The remaining gap is the batches themselves (each socket still gets 20 cursor messages a second). Ops alone hit the runner's ceiling between 50 and 100 editors: 100 editors means 25,000 deliveries/s.

## Results: laptop (secondary)

`laptop/load-cursors-unbatched.json`. This run happened before cursor batching and stopped after 20 editors, because free RAM fell to 409 MB (the stop line is 500 MB). The laptop had about 0.6 GB free before the stack even started.

| Editors | Split | p50 | p95 | p99 | Same / cross p95 | Ops/s sent / acked | Deliveries/s | Server CPU (each) | Server RAM MB (each) | nginx CPU | Generator CPU | Host free RAM MB (min) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 5 + 5 | 7.6 | 23.6 | 41.9 | 21.4 / 24.7 | 49 / 49 | 444 | 31, 30 | 62, 45 | 15 | 23 | 599 |
| 20 | 10 + 10 | 169 | **2.0 s** | 2.5 s | 2.0 s / 2.1 s | 100 / 103 | 1,959 | 105, 113 | 70, 67 | 89 | 66 | 409 |

On the laptop, p95 crosses 150 ms between 10 and 20 editors, with cursors relayed one by one. At 20 editors each replica is pegged at one core (105–113%), and nginx is close (89%). The laptop is also about 3× slower than the runner at light load (p50 7.6 ms against 1.7–2.4 ms with 10 editors): Docker Desktop's WSL2 networking and a CPU at 2.1 GHz shared with the developer's apps.

## Chaos tests (laptop, 10 editors under load)

`laptop/chaos.json`:

| Fault | What happened | Pass condition |
| --- | --- | --- |
| SIGKILL one replica (6 of 10 clients on it) | All 6 reconnected through nginx to the other replica in **2.7 s**; the replica was started again and healthy 7 s after the kill | Every client connected; no acked op lost (checked at the end) |
| `docker restart` Redis | Redis back in 1.7 s; every client still connected; seq counter 1208 = max seq in Postgres | No seq collision logged; counter ≥ max seq |
| `redis-cli FLUSHALL` (seq counters lost) | The counter restarted from the rooms' floor (2388 = max seq in Postgres), not from 1 | No seq collision logged |
| `docker pause` Postgres for 40 s | "Saving paused" shown after **32 s** on all 10 clients; cleared on all of them **0.2 s** after unpausing | Every op acked after recovery |
| **End state** | 873 acked markers, **0 missing**; every bot's last value on the board; **0 diverged** boards; 0 seq collisions over the whole run | PASS |

## What the tests found, and what changed

1. **nginx failover took 60 s.** The WebSocket route used nginx's default 60 s connect timeout. A reconnect routed to the killed replica's address hung for a minute before nginx tried the other one, so the first chaos run timed out. Now the connect timeout is 2 s on both proxied routes, and a replica that fails a connect is skipped for 10 s. After the fix, clients failed over in 2.7 s.
2. **"Saving paused" never showed for a frozen Postgres.** Each query has a 15 s client timeout and is retried up to 3 times, so one commit attempt hung for about 60 s before it failed. The 30 s pause clock started only at that first failure, so a 40 s outage passed unnoticed. Now the clock starts at the batch's first attempt, and a watchdog pauses saving if a commit is still pending after 30 s, failed or not. Tested in `OpWriter.test.ts`; in the chaos rerun the pause showed at 32 s.
3. **Cursor fan-out dominated the load.** Details above. Each room now keeps the latest cursor per peer and sends each socket one `cursors` message every 50 ms, serialized once; servers exchange the same batches over Redis (algorithms.md §8).
4. **Fixes to the test tooling, kept honest:**
   - The first GitHub run counted closed sockets only inside measuring windows, so bots that died between steps went unnoticed. The 50- and 100-editor numbers in that run were invalid. They are kept in `superseded/` and not used here.
   - One chaos run reported "diverged" boards that differed only in the key order of JSON from Postgres (JSONB reorders keys). The comparison now sorts keys.

## Known limits and next steps

- **Overload makes things worse.** A replica too busy to read Redis's replies within 2 s closes sockets with 1013. Those clients reconnect and add load (seen past 50 editors on the runner). Shedding load more gently would keep sockets open: back-pressure instead of closing, or a longer seq timeout once the socket is already established.
- **Relayed ops are serialized once per receiving socket.** Cursors are now serialized once per tick; doing the same for op broadcasts would cut the per-delivery cost further.
- **The real capacity numbers need separate machines:** a dedicated generator host, and replicas with their own cores. The runner here gives all of it 2 vCPUs.
