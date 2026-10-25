# CLAUDE.md — Collaborative Whiteboard

Real-time multiplayer whiteboard (like a mini Excalidraw/Miro). Resume project.
The point of the project is the sync algorithms and backend design, so **write the core logic ourselves** — do not pull in libraries that do sync, CRDTs or canvas scene management for us.

Full design docs live in `docs/`:
- `docs/system-design.md` — architecture, protocol, data model, failure handling
- `docs/algorithms.md` — Lamport clocks, LWW, tombstones, fractional indexing, RDP, quadtree, camera maths

Read the relevant section before implementing a feature. If the code and the docs disagree, ask me before changing either.

## Stack

- TypeScript (strict) everywhere, pnpm workspaces monorepo
- `packages/shared` — types, Lamport clock, LWW board, fractional indexing, geometry, Zod protocol schemas
- `packages/client` — React 18 + Vite for UI chrome; **raw Canvas 2D** for the board
- `packages/server` — Node 22, Fastify (REST), `ws` (WebSockets), Drizzle + PostgreSQL 16, Redis 7 (ioredis)
- Tests: Vitest (unit, integration, convergence), Playwright (multi-browser E2E)
- Local infra: `docker-compose.yml` with postgres + redis

## Commands

```bash
docker compose up -d          # postgres (host port 55432) + redis (56379); 5432/5433 are taken on this machine
pnpm install
pnpm dev                      # client (Vite) + server (tsx watch) together
pnpm test                     # all Vitest suites (convergence test with 50 seeds)
pnpm test:convergence         # randomized convergence test, all 500 seeds (must always pass)
CONVERGENCE_SEED=42 pnpm test:convergence   # replay one failing seed (CONVERGENCE_SEEDS=n changes the count;
                              # the run fails at CONVERGENCE_DEADLINE_MS, default 120 s, checked between seeds)
pnpm test:watch               # Vitest in watch mode
pnpm test:integration         # Vitest against Docker Postgres (db whiteboard_test) and Redis (db 1)
pnpm test:e2e                 # builds first (build:e2e), then Playwright (Chromium) against built output: db whiteboard_e2e,
                              # Redis db 2, servers :3101/:3102 from the bundle (tests may kill/restart them), clients
                              # :5199/:5200 via `vite preview` (each proxies to its server)
pnpm build:e2e                # server bundle + client `--mode e2e` (keeps window.__board) -> packages/client/dist-e2e
pnpm -F server db:migrate     # run Drizzle migrations (the server also runs them on start)
pnpm -F server db:generate    # new migration from src/db/schema.ts (never connects to a DB)
pnpm -F server build          # production bundle (esbuild) -> packages/server/dist
pnpm typecheck && pnpm lint

# Production stack (cp .env.prod.example .env.prod and fill in secrets first; .env.prod is never committed)
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build --wait   # app on :8080
pnpm test:smoke               # Playwright smoke test against the running production stack
node scripts/measure-startup.mjs 3   # recreate the prod server container 3x; prints startup phases and time to healthy

# Benchmarks against the production stack (start it with AUTH_RATE_LIMIT_PER_MIN=1000 so the bots can sign up)
pnpm bench:load               # load ramp (BOT_STEPS, WORKERS, MEASURE_MS, CURSOR_MS, MIN_FREE_MB) -> docs/bench-results
pnpm bench:chaos              # kill a replica, restart/flush Redis, pause Postgres, under load (BOTS, PG_PAUSE_MS)
gh workflow run load-test.yml -f steps=10,20,30,50,100   # the load ramp on a GitHub runner; results as an artifact
```

Keep these scripts working; add new ones to this list when you create them.

## Production standards (apply to everything, in every milestone)

This is a production system, not a demo. These standards are part of each milestone's work, not extra features.

**Code and correctness**
- No TODO shortcuts in merged code. Every known limitation is listed under "Known limitations" below, with the milestone that removes it.
- Every error path is handled: no unhandled promise rejections, no crash on bad input. Typed errors (`AppError`, Zod) map to proper HTTP statuses and WS `error`/close codes; unknown errors become a logged 500 with no internals leaked. `unhandledRejection`/`uncaughtException` log fatally and shut down gracefully.

**Configuration and secrets**
- All config comes from environment variables, validated with Zod at startup (`packages/server/src/config.ts`). The server refuses to start with missing or invalid config and names each problem, never the values. Production has no defaults for DATABASE_URL, REDIS_URL, JWT_SECRET or ALLOWED_ORIGINS, and rejects fault injection and the dev secret.
- `.env.example` and `.env.prod.example` are committed; real `.env*` files and secrets never are.

**Database**
- Schema changes only through migrations (`db:generate`). Migrations run on every start, under a Postgres advisory lock so replicas don't race.
- Multiple writes that must succeed together run in one transaction (board + owner membership; snapshot + prune). Board loads read snapshot + tail in one repeatable-read transaction.

**Security**
- Everything in system-design.md "Security": upgrade auth (cookie + role + Origin), per-batch role checks, Zod validation with stripped unknown fields, ownership rules, rate limits (ops 200/s per user with throttling then disconnect, messages per socket, 5 sockets per user), bcrypt cost 12, no `innerHTML`.
- Secure headers (@fastify/helmet on the API; strict CSP and friends from nginx for the app), CORS restricted to ALLOWED_ORIGINS, session cookie httpOnly + Secure (production) + SameSite=Lax, login/signup rate-limited per IP.

**Observability**
- Structured JSON logs (pino). Every request line has `reqId` (also returned as `x-request-id`), every socket line has `connId` (+ userId, boardId). Passwords, tokens and cookies are redacted and never logged.
- `/healthz` (process up), `/readyz` (Postgres + Redis reachable, not shutting down), `/metrics` (Prometheus: system-design.md metrics, optional bearer token). None are exposed through the public nginx.

**Reliability**
- Graceful shutdown on SIGTERM/SIGINT: stop accepting sockets, flush the op log (acks go out), close sockets with 1012 (clients reconnect within ~0.5 s), snapshot rooms, close Postgres/Redis. 25 s hard cap.
- Every Postgres/Redis call has a timeout. Reads and idempotent writes retry with jittered backoff on transient errors (`withRetry`); non-idempotent inserts fail fast with 503. The OpWriter retries until committed (no ack meanwhile).

**Delivery**
- GitHub Actions (`.github/workflows/ci.yml`): typecheck, lint, unit, convergence, integration and E2E with Postgres/Redis services on every push and PR, plus a job that builds the production images, starts docker-compose.prod.yml and runs the smoke test.
- Production images: multi-stage, non-root (server: node user, bundled with esbuild; client: nginx-unprivileged). `docker-compose.prod.yml` runs the full stack with only the app port published, read-only containers and no-new-privileges.
- Every milestone is verified against the production stack too: build it, start it, run `pnpm test:smoke`.

## Known limitations (each removed by the milestone named)

| Limitation | Removed in |
| --- | --- |

## Core design rules (do not break these)

1. **The board is a map of shapes keyed by ID.** IDs are generated on the client as `clientId-counter`. Never ask the server for IDs.
2. **Every change is an op:** `create`, `update` (partial props), `append` (stroke points, author only). Delete = `update { deleted: true }`.
3. **Every op carries a Lamport stamp `{ t, client }`.** Conflicts resolve per property with Last-Writer-Wins: higher `t` wins, tie broken by `client` string comparison. Never use `Date.now()` to order edits.
4. **Merge must be commutative, associative and idempotent.** Applying the same ops in any order, with duplicates, must give identical boards. The convergence test enforces this — run it after touching anything in `shared`.
5. **Deleted shapes are tombstones.** Keep applying LWW updates to them; the renderer just hides them. Never skip updates to deleted shapes.
6. **Z-order uses fractional index strings** (`keyBetween`), sorted by `(z, id)`. Reordering changes only the moved shape.
7. **Optimistic updates:** the client applies its own ops immediately, keeps them in a pending queue, and removes them on `ack`. Resend pending ops after reconnect.
8. **Server acks only after the op is committed to Postgres.** Peers are broadcast to right after the in-memory apply, without waiting for the DB.
9. **Presence (cursors, selections, online list) is ephemeral:** never written to Postgres.
10. **World vs screen coordinates:** everything synced or stored is in world coordinates. Convert pointer events with `camera.toWorld` first.
11. `packages/shared` must not import DOM, network or database code — it has to run in plain Node for tests.
12. Client and server import from `shared`, never from each other.

## Code conventions

- Strict TypeScript, no `any`. Prefer plain functions and small classes over frameworks.
- Validate every incoming WebSocket message with the Zod schemas in `shared/protocol.ts`; the server attaches `userId` from the socket, never trusts it from the client.
- Check the user's board role on every op batch, not only at connect.
- React must not re-render on every shape change: the canvas reads from `BoardStore`; React subscribes only to UI-level events (selection, tool, connection status, online users).
- Never use `innerHTML` with user content.
- Small, focused commits with clear messages. One feature per branch/PR-sized change.

## How I want you to work

- Before starting a feature, tell me in 3–5 lines what you'll build and which files you'll touch.
- Write tests alongside the code: unit tests for every algorithm, and extend the convergence test when adding a new op type or property.
- Run `pnpm typecheck` and `pnpm test` before saying a task is done, and report the results honestly — including failures.
- Explain non-obvious algorithm code with short comments (why, not what). I need to understand and defend every part in interviews.
- If something in the design seems wrong or a simpler approach exists, say so before implementing — don't silently change the design.
- Don't add dependencies without telling me why. Never add Yjs, Automerge, Liveblocks, Socket.io, Konva or Fabric.js.

## Current status

Update this section at the end of each session: what's done, what's next, known bugs.
Build milestones in this order; tick them off as they're finished.

- [x] Monorepo + shared core (clock, LWW board, tombstones, fractional index) + convergence test
- [x] Canvas renderer + camera (pan, zoom-to-cursor, HiDPI)
- [x] Quadtree, hit testing, select & shape tools
- [x] Server rooms + WebSocket sync (pending queue, acks, broadcast)
- [x] Postgres persistence, snapshots, auth, roles
- [x] Pen tool (streaming, RDP, smoothing), eraser, presence
- [x] Undo/redo, sticky notes, reconnect + catch-up
- [x] Redis pub/sub multi-server, sharing, rate limits
- [x] E2E, chaos and load tests
- [ ] Deploy, README, demo video

**Session 2026-10-23:** milestone 1 done. pnpm is pinned to 10.18.3 (pnpm 12 doesn't run under Node 22.20's corepack).
`shared` consumers import its TypeScript source directly (`exports` → `src/index.ts`); no build step yet.

Decisions (also in the docs):
- Pen-down `create` leaves `points` unset; the first point goes in `append` chunk 0 in the same batch. `points` is written only at pen-up (algorithms.md §7a).
- Ops buffered before their create: no time-based expiry; cleared when a fresh snapshot is loaded; capped at 10,000 per board (drop oldest, warn via `onBufferOverflow`). The server never buffers: it rejects updates/appends to unknown shapes (algorithms.md §3).
- The sticky-note shape type is `'note'` (its content is the `text` property).
- Stroke points are relative to the stroke's `x, y` (its pen-down point). Its bounding box is computed from the
  points, never stored; `w`/`h` are unused. Strokes can't be resized in v1: move, recolor, delete only (algorithms.md §7a).
- Viewers get a read-only UI (no selection or handles, drawing tools/colors/actions and edit shortcuts disabled, pan and
  zoom work, "View only" badge), switched live by `{t:'role'}`. The server still rejects any viewer op.
- Tombstone GC (milestone 7): a tombstone's age is the server's commit time of the op that set `deleted: true`
  (`board_ops.created_at`); `shared` stays free of wall-clock time.

Workflow: one branch per milestone (`milestone-N-name`). I don't check milestones manually: verify each one yourself in a
real browser (Playwright E2E, plus looking at screenshots) and against the production stack (`pnpm test:smoke`), and
treat typecheck + lint + unit + convergence + integration + E2E + smoke all passing as approval to merge into main and
tick it off. Every milestone adds E2E tests for its features and follows the Production standards above. E2E reads tab state only through `window.__board` (read-only,
dev builds only) and acts only through real mouse/keyboard input.

Milestone 2 done and merged: client package, Camera, Renderer (two layers, draw on demand, HiDPI), pan/zoom input,
rect/ellipse/arrow drawing, demo shapes (`?demo=N`). Checked in the browser, including `?demo=20000`.
Vite falls back to port 5174 when 5173 is taken.

Milestone 3 done and merged (checked in the browser): quadtree culling + hit testing, select tool (click, shift-click,
drag-move, handle resize, box-select), rect/ellipse/arrow tools, toolbar, colors, front/back, delete. All local edits go
through `BoardStore.submit()` (emits `submit` for sync/undo later); remote ops through `receive()`. Handles 8 px and hit
tolerance 6 px in screen pixels, divided by zoom. Drag sends one update per pointer move; merging same-shape updates
every 50 ms is the sync outbox's job (milestone 4).
- Z keys are integer part + fraction (algorithms.md §5): 4 chars after 20,000 top inserts (was 3,334); first key `i0`.

Milestone 4 done and merged: `packages/server` (Fastify + raw `ws` on /ws, port 3001; Vite proxies /ws and /api), Room
op pipeline (role check per batch -> validate -> seq -> apply -> broadcast -> `await opStore.append` -> ack), dedupe of
resent ops by opId, Zod protocol in `shared/protocol.ts`, SyncClient (50 ms outbox with the drop-only merge rule, pending
until ack, rollback to the server's registers then re-apply other unacked ops for that shape), connection badge.
Board id from `?board=`. Verified by `tests/sync.test.ts` and Playwright E2E (2-3 tabs, concurrent drags, delete vs drag,
late join, plus camera and tools for milestones 2-3).
M4 scope limits (lifted in M5/M7): anonymous per-socket userId with editor role, in-memory OpStore, rooms never unloaded,
no reconnect (badge says reload). `?demo=N` is off by default and seeds only an empty board after welcome.

Milestone 5 done and merged: Drizzle schema + migration (drizzle/0000_init.sql), OpWriter (multi-row insert every 50 ms /
200 ops, ON CONFLICT (board_id, op_id) DO NOTHING, retry with backoff; acks wait for it), Snapshotter (every 500 ops / 60 s
/ on unload; writes only after the OpWriter has drained; deletes ops <= the previous snapshot), rooms load from snapshot +
tail and unload 60 s after the last socket, auth (bcryptjs cost 12, JWT in httpOnly SameSite=Lax cookie, 7 days), boards and
members REST, WebSocket upgrade checks Origin + session + role (400/401/403), live role push (`{t:'role'}`), close codes
4003 removed / 4004 board deleted. Client: login/signup, board list, board header, View-only badge, auto-reconnect with
backoff (resends pending on welcome). Fault injection for tests: WB_FAULT_COMMIT_DELAY_MS / WB_FAULT_ACK_DELAY_MS (ignored in
production).
Numbers for the README (E2E test 5, dev build, bcrypt cost 4 for tests): board with 2,100 ops / 1,000 shapes loads in
77–176 ms on the server (snapshot seq 2000 + 100-op tail); browser open-to-rendered 0.9–2.6 s (includes Vite dev page load).
Deferred items are tracked in "Known limitations" above.

Production hardening pass (branch `hardening`, merged): everything in "Production standards" above. Verified with the
production stack on this machine: images build (client 74 MB, server ~250 MB), stack healthy, smoke test passes (sign up,
draw, reload, shape persists, strict CSP, Secure/httpOnly cookie, /metrics and /readyz not public), production logs have
no warnings and no secrets.
Startup (fixed in `m6-followups`): the server logs `startup complete` with phase timings. Causes found: source-map parsing
at runtime (`--enable-source-maps`, removed; maps still shipped, enable with NODE_OPTIONS when debugging) and the 10 s
health-check interval (now `--start-interval=1s`). Node phases 2.3-3.5 s -> 1.2-2.3 s; container started -> healthy
3.9-4.4 s (was 9-21 s + up to 10 s check lag). The rest is Docker Desktop on this Windows machine: an empty `/bin/true`
container takes 5-12 s to create/run here, which no app change affects.

Milestone 6 done and merged: pen tool (create + append chunk 0 in one batch, 50 ms chunks, unsent tail drawn on the
overlay, pen-up `points` = iterative RDP with epsilon 1 screen px), midpoint quadratic Bezier smoothing at draw time,
whole-stroke eraser (8 px, swept between pointer events), strokes selectable/movable/recolorable (no handles). Presence:
`cursor`/`select`/`ping` from clients, `peer-join`/`peer-leave`/`cursor`/`select` from the server with a per-connection
`peerId` (same user in two tabs = two cursors; online list groups by user); cursors throttled to 20/s with a trailing
send, eased 30%/frame, colored by a hash of the user id, hidden after 30 s idle; heartbeat every 5 s, peers silent for
15 s are terminated (PRESENCE_TIMEOUT_MS / PRESENCE_SWEEP_MS). Toolbar is left-anchored; header (title, online list,
user) top right. Shortcuts P (pen), E (eraser).

Milestone 7 done and merged: per-tab undo/redo (`client/src/store/History.ts`, 100 steps; a pointer gesture = one step;
a property whose current stamp isn't this tab's is skipped; Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y, Undo/Redo buttons bottom
left). Sticky notes (`note` type, N; double-click to edit; textarea over the note; text saved once on blur as one LWW
update; presence `typing` soft-locks the note in other tabs with "Name is typing…"). Catch-up: each room keeps the ops
since its previous snapshot in memory; `hello.lastSeq` inside that log gets `welcome { ops }`, otherwise (first join,
too far behind, ahead of the server, or a tombstone GC after lastSeq) `welcome { snapshot }`; pending ops are resent
either way. Clients close the socket on the browser `offline` event ("Offline" badge), reconnect on `online`, and treat
3 silent heartbeats as a dead socket (server answers `ping` with `pong`). Tombstone GC at snapshot time for tombstones
older than `TOMBSTONE_TTL_MS` (default 24 h; age from `board_ops.created_at`, carried in the snapshot as `deletedAt`).
Metrics `catchup_ops`, `welcomes_total{kind}`, `tombstones_collected_total`.

Stretch goal done and merged (branch `offline-queue`): IndexedDB offline queue (`client/src/sync/OfflineQueue.ts`, plain
IndexedDB, no wrapper). One queue per tab (`boardId:tabId`, tab ID in sessionStorage); each open tab holds a Web Lock for
its queue, and a loading tab adopts every queue of this board whose lock is free (its own after a reload, closed tabs');
queues of another user are deleted; restored ops are stamp-sorted, observed by the clock and applied before tools unlock
and the socket opens. No service worker, so a reload while offline shows the browser's offline page; the next online load
sends the queue. E2E simulates an outage as offline mode + refused WebSockets (`routeWebSocket`): offline mode alone
leaves WebSockets alone and fires `online` in the old page during `page.reload()`.
Machine note: this Windows box is short of memory (commit ~22/24 GB with the user's apps); run Docker image builds and
test suites one after the other, never at the same time.

Milestone 8 done and merged: several servers behind one board via Redis (system-design.md "Server design"). Seqs from a
Lua `INCRBY` with a floor (never below the highest seq the room has seen); ops delivered the moment a server has them, in
any order; each server's watermark `upTo` (highest contiguously delivered seq; gaps read from Postgres every 250 ms,
holes skipped after 5 s, rejected ops' seqs published as `skip`) goes out on welcome/ops/ack and is the client's lastSeq.
A room loads by subscribing first, then snapshot + tail, then the Redis counter; a client whose lastSeq is ahead of the
room waits (up to 6 s) for the room to fill in before its welcome. Resends known only from another server are acked once
in Postgres, else re-sequenced after 5 s; a (board_id, seq) collision is not acked. Presence over `presence:{id}` with an
`online:{id}` hash per connection (crashed servers' peers swept after 15 s). Redis token bucket and socket cap per user,
login limit per IP in Redis, snapshot lock `snap-lock:{id}`. Role/removal/deletion fan out on `board:{id}`. Logout
revokes the JWT's `jti` (`revoked:{jti}`) and closes that session's sockets everywhere (4001); REST and the upgrade fail
closed (503) without Redis. "Saving paused" after `SAVE_PAUSE_AFTER_MS` (30 s) of failing commits: `saving {paused}`,
batches dropped unapplied, clients resend on resume. Share links (`PUT/GET /api/boards/:id/link`, `POST /api/join/:token`,
32-byte tokens rotated on every change, never lowering a role) with a Share dialog (invite, roles, remove, link) and a
`?join=` route. Config: SERVER_ID, SAVE_PAUSE_AFTER_MS, GAP_POLL_MS, GAP_HOLE_MS, WB_FAULT_CONTROL (test-only route
`POST /api/__test/faults`, refused in production). Tests: Redis db 1 (integration) / 2 (E2E), flushed like Postgres.
E2E harness runs against built output (two bundled servers, two `vite preview` clients) instead of tsx + Vite dev servers.

Milestone 9 done and merged (see docs/benchmarks.md): load ramp (`scripts/bench/load.ts`) and chaos test
(`scripts/bench/chaos.ts`) against the production stack, plus a manual GitHub workflow for the ramp (`load-test.yml`).
Headline (GitHub runner, 2 vCPU, everything on one host, so a lower bound): one board holds p95 < 150 ms up to 50 editors
(p50 21 / p95 66 / p99 97 ms, 248 ops/s, 12k deliveries/s); crosses between 50 and 60. Laptop (5.8 GB RAM, cursors not yet
batched): crosses between 10 and 20; stopped at 20 for low RAM. Chaos (laptop, 10 editors): replica kill -> reconnect 2.7 s,
Redis restart and FLUSHALL -> no seq collisions, Postgres frozen 40 s -> "Saving paused" at 32 s, nothing lost, all converged.
Found and fixed: nginx waited 60 s on a dead replica (now 2 s connect timeout, failed replica skipped 10 s); a frozen
Postgres never showed "Saving paused" (outage clock from the batch's first attempt + watchdog); cursor fan-out was O(n^2)
(server now batches cursors: one `cursors` message per socket per 50 ms). Known limit: an overloaded replica closes sockets
(1013) on Redis timeouts, which adds reconnect load. Benchmark results in docs/bench-results (github/, laptop/, superseded/).

Milestone 10 in progress: deployed at https://collab-whiteboard-nmn6.onrender.com (Render free web service serving the
built client via STATIC_DIR + Render Key Value, Neon Postgres; created with the Render CLI/API, see docs/deploy.md).
Checked live: CSP/HSTS/secure cookies, two users syncing over wss (~340 ms relay from India to Oregon), persistence,
logout revocation, browser sign-up and drawing. README written. Still to do: demo video; the repo is still private
(owner to decide: commits carry the author's email).
