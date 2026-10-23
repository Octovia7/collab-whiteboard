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
pnpm typecheck && pnpm lint
```

Keep these scripts working; add new ones to this list when you create them.

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
- [ ] Pen tool (streaming, RDP, smoothing), eraser, presence
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
real browser (Playwright E2E, plus looking at screenshots), and treat typecheck + lint + unit + convergence +
integration + E2E all passing as approval to merge into main and tick it off. Every milestone adds E2E tests for its features. E2E reads tab state only through `window.__board` (read-only,
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
Deferred: tombstone GC (needs deletion wall-clock times; tied to milestone 7's too-far-behind snapshot logic), lastSeq
catch-up (M7), Redis snapshot lock + INCR seq (M8), share links + login rate limit (M8), OpWriter "Saving paused" breaker.
