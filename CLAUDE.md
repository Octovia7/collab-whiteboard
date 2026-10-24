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
CONVERGENCE_SEED=42 pnpm test:convergence   # replay one failing seed (CONVERGENCE_SEEDS=n changes the count)
pnpm test:watch               # Vitest in watch mode
pnpm test:integration         # Vitest against Docker Postgres (db whiteboard_test)
pnpm test:e2e                 # Playwright (Chromium); db whiteboard_e2e, server :3101 (tests may kill/restart it), client :5199
pnpm -F server db:migrate     # run Drizzle migrations (the server also runs them on start)
pnpm -F server db:generate    # new migration from src/db/schema.ts (never connects to a DB)
pnpm -F server build          # production bundle (esbuild) -> packages/server/dist
pnpm typecheck && pnpm lint

# Production stack (cp .env.prod.example .env.prod and fill in secrets first; .env.prod is never committed)
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build --wait   # app on :8080
pnpm test:smoke               # Playwright smoke test against the running production stack
node scripts/measure-startup.mjs 3   # recreate the prod server container 3x; prints startup phases and time to healthy
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
| No `lastSeq` catch-up: every (re)connect gets a full snapshot; `catchup_ops` metric not emitted yet | M7 |
| Tombstones are never garbage-collected (age = `board_ops.created_at` of the delete op) | M7 |
| Undo/redo, sticky notes | M7 |
| Rate limits, socket caps, the snapshot lock and presence (online list, cursors) are per server process (in memory); seq is assigned in memory | M8 (Redis: `rl:ws:*`, `INCR seq`, `snap-lock`, `presence:*` pub/sub, `online:*` hash) |
| Single server only: no pub/sub between servers, no gap detection | M8 |
| No share links; members are added by email only | M8 |
| OpWriter has no "Saving paused" circuit breaker after 30 s of Postgres failures (it retries forever, without acking) | M8 |
| A logged-out session's existing sockets stay open until they close (JWT is stateless) | M8 (session revocation on logout) |
| No load test numbers yet | M9 |

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
- [ ] Undo/redo, sticky notes, reconnect + catch-up
- [ ] Redis pub/sub multi-server, sharing, rate limits
- [ ] E2E, chaos and load tests
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
