# Collaborative Whiteboard — System Design

A real-time multiplayer whiteboard in TypeScript: Canvas 2D in the browser, a Node.js WebSocket server, Redis and Postgres. The sync algorithms are explained in `docs/algorithms.md`; this doc covers how the system is built around them.

## Requirements and targets

Up to 30 people edit one board at once, every screen converges to the same state, and local edits never wait for the network. All of it runs free: locally in Docker, and on free tiers for the demo.

**Functional**

- Sign up / log in; create, rename, delete and list boards.
- Share a board by link with a role: owner, editor or viewer.
- Tools: select, rectangle, ellipse, arrow, freehand pen, sticky note with text, eraser.
- Move, resize, recolor, delete, reorder (bring to front / send to back), multi-select, copy/paste. Freehand strokes can't be resized in v1 (move, recolor, delete only).
- Live: other people's edits, cursors with names, selections, and an online list.
- Per-user undo/redo.
- Infinite canvas with pan and zoom.
- Boards are saved automatically and survive a server restart.
- Reconnect after a network drop without losing work.

**Non-functional targets**

| Target | Value |
| --- | --- |
| Local edit to own screen | Under 16 ms (next frame) |
| Edit to other users' screens | p95 under 150 ms on a normal connection |
| Concurrent editors per board | 30 |
| Shapes per board | 10,000 at 60 fps pan/zoom |
| Board load time | Under 1 s for 10,000 shapes |
| Data loss on server crash | None for acknowledged ops; unacknowledged ops are resent by clients |
| Convergence | All clients identical after edits stop, verified by randomized tests |
| Cost | ₹0 |

**Out of scope for v1:** images and file uploads, partial-stroke erasing, text CRDT inside notes (LWW on the whole text instead), mobile-optimised UI, export to PNG/PDF, version-history UI.

## Architecture

Browsers do the drawing and hold a full copy of the board; Node servers validate, order and persist ops; Redis connects the servers and Postgres stores everything permanently.

```
 Browser (user A)                          Browser (user B)
 React UI + Canvas 2D renderer             Same code; may reach a different server
 BoardStore (LWW) + SyncClient             Converges with A through LWW
        |  HTTPS + WebSocket                       |  HTTPS + WebSocket
        v                                          v
 +------------------------------------------------------------------+
 |           Load balancer (nginx), no sticky sessions needed       |
 +------------------------------------------------------------------+
        |                                          |
        v                                          v
 Node server 1                              Node server 2
 Fastify REST: auth, boards, sharing        Identical process
 WebSocket rooms: validate, apply, ack      Holds its own copy of active rooms
 OpWriter + Snapshotter                     Add more servers the same way
        |                                          |
        +--------------------+---------------------+
                             |
              +--------------+---------------+
              v                              v
 Redis                                    Postgres
 Pub/sub of ops and presence              Users, boards, members
 Seq counters, online list, locks,        Op log + snapshots (source of truth)
 rate limits
```

Any browser can land on any server. Server 1 relays an op to its own sockets and publishes it to Redis, which delivers it to server 2 for its sockets. Postgres is the only place a board lives permanently; a server's in-memory room can always be rebuilt from it.

## Tech stack

TypeScript everywhere, so the sync logic (stamps, LWW merge, op types) is written once in a shared package and runs identically in the browser, on the server and in tests.

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (strict) | One set of types for client, server and protocol |
| Repo | pnpm workspaces monorepo | `client`, `server`, `shared` packages |
| Frontend | React 18 + Vite | Toolbar, panels, dialogs; the board itself is canvas |
| Drawing | Raw Canvas 2D | Fast, full control, nothing hidden |
| Client state | Plain classes + a tiny event emitter | The board store changes 60×/s; React state would re-render too much |
| Offline queue | IndexedDB (plain API) + Web Locks | Unacked ops survive a reload or a closed tab. Three IndexedDB calls don't need a wrapper library |
| Server | Node.js 22 + Fastify | REST API |
| WebSockets | `ws` library on the same Fastify server | Plain, fast, no Socket.io magic to hide behind |
| Validation | Zod | Every incoming message is parsed and checked |
| Database | PostgreSQL 16 + Drizzle ORM | Users, boards, members, op log, snapshots |
| Pub/sub + counters | Redis 7 | Cross-server fan-out, per-board sequence numbers, presence |
| Auth | JWT in an httpOnly cookie, bcrypt passwords | Simple, works for the WebSocket upgrade too |
| Tests | Vitest; Playwright for multi-browser E2E | Convergence tests run in plain Node |
| Load test | Custom Node script with N `ws` clients (or k6) | Measures op relay latency |
| Local infra | Docker Compose: postgres + redis | One command to run |
| Demo hosting (free) | Frontend on Vercel or Netlify; server on a free Node host; Neon/Supabase Postgres; Redis Cloud free plan | Check current free-tier limits when deploying |

## Monorepo structure

The `shared` package holds everything both sides must agree on; `client` and `server` only import from it, never from each other.

```
whiteboard/
├── docker-compose.yml             # postgres + redis
├── packages/
│   ├── shared/src/
│   │   ├── types.ts               # Shape, Stamp, Op, Reg<T>
│   │   ├── clock.ts               # Lamport tick/observe/compare
│   │   ├── board.ts               # LWW map: applyOp, snapshot, fromSnapshot
│   │   ├── fractional.ts          # keyBetween
│   │   ├── protocol.ts            # Zod schemas for every WS message
│   │   └── geometry.ts            # Box, overlaps, distToSegment, rdp
│   ├── client/src/
│   │   ├── main.tsx, App.tsx      # React shell, routing, auth pages
│   │   ├── ui/                    # Toolbar, ShareDialog, UserList, ZoomControls
│   │   ├── canvas/
│   │   │   ├── Renderer.ts        # render loop, two layers, dirty flags
│   │   │   ├── Camera.ts          # pan, zoom, toWorld/toScreen
│   │   │   ├── QuadTree.ts
│   │   │   ├── draw/              # rect.ts, ellipse.ts, arrow.ts, stroke.ts, note.ts
│   │   │   └── TextEditor.ts      # textarea overlay for notes
│   │   ├── tools/                 # SelectTool, ShapeTool, PenTool, EraserTool, NoteTool
│   │   ├── store/
│   │   │   ├── BoardStore.ts      # shared/board + quadtree + change events
│   │   │   ├── History.ts         # undo/redo stacks
│   │   │   └── Presence.ts        # remote cursors, selections, interpolation
│   │   └── sync/SyncClient.ts     # socket, pending queue, acks, reconnect, lastSeq
│   └── server/src/
│       ├── index.ts               # Fastify + ws upgrade
│       ├── http/                  # auth.ts, boards.ts, members.ts
│       ├── ws/
│       │   ├── connection.ts      # auth on upgrade, message dispatch
│       │   ├── RoomManager.ts     # boardId -> Room, load/unload
│       │   └── Room.ts            # in-memory board, sockets, op pipeline
│       ├── persistence/
│       │   ├── OpWriter.ts        # batched inserts into board_ops
│       │   └── Snapshotter.ts     # snapshots + tombstone GC
│       ├── pubsub.ts              # Redis publish/subscribe per board
│       └── db/                    # Drizzle schema + migrations
└── tests/
    ├── convergence.test.ts        # randomized multi-client test
    ├── e2e/                       # Playwright, 3 browsers on one board
    └── load/                      # N-client latency script
```

**Rule worth keeping:** nothing in `shared` touches the DOM, the network or the database. That's what lets the convergence test run thousands of simulated clients in milliseconds.

## Client design

The client has four parts that talk through the BoardStore: tools turn mouse input into ops, the store applies them, the renderer draws the store, and the sync client exchanges ops with the server. React only draws the UI around the canvas.

**BoardStore** is the single source of truth in the browser.

- Holds the LWW map from `shared/board.ts` and the QuadTree.
- `apply(op, origin: 'local' | 'remote')`: merges with LWW, updates the quadtree for changed shapes, emits `change` so the renderer sets its dirty flag.
- Local ops also go to `History` (for undo) and to `SyncClient` (to send).
- Exposes read helpers: `visibleIn(box)`, `hitTest(point)`, `sortedForDraw(ids)`.

**Tools** follow one interface; the active tool receives pointer events already converted to world coordinates.

```ts
interface Tool {
  onPointerDown(p: WorldPoint, e: PointerEvent): void;
  onPointerMove(p: WorldPoint, e: PointerEvent): void;
  onPointerUp(p: WorldPoint, e: PointerEvent): void;
  drawOverlay?(ctx: CanvasRenderingContext2D): void;   // previews, selection box
}
```

| Tool | Pointer down | Move | Up |
| --- | --- | --- | --- |
| Select | Hit test; select shape or start box-select | Drag selected shapes (local preview, ops batched every 50 ms) | Commit one undo entry |
| Rect / Ellipse / Arrow | Create shape at point | Resize preview | Final update; undo entry |
| Pen | Create stroke (no `points`) + append chunk 0 with the first point, same batch | Append point chunks, streamed every 50 ms | RDP-simplify, final LWW update of `points` |
| Eraser | Hit test at point | Delete each stroke the eraser touches | One undo entry for all |
| Note | Create note, open textarea overlay | | Text saved on blur as one LWW update |

**Renderer**

- Two stacked canvases: **scene** (shapes) and **overlay** (cursors, selections, previews, the stroke being drawn).
- One `requestAnimationFrame` loop; each layer has its own dirty flag.
- Scene draw: camera transform → quadtree query for the viewport → skip tombstones → sort by `(z, id)` → draw.
- Canvas sized at `devicePixelRatio` for sharp output; resized on window resize.

**SyncClient**

- Connects to `wss://…/ws?board=<id>` (cookie carries the JWT).
- Sends `hello { lastSeq }`, receives the initial snapshot or catch-up ops.
- Keeps the pending queue; batches outgoing ops every 50 ms; removes them on `ack`.
- Reconnects with exponential backoff (0.5 s, 1 s, 2 s… max 10 s), then resends pending ops (built in milestone 5; `lastSeq` catch-up instead of a full snapshot comes in milestone 7). It does not reconnect after the close codes below.
- Sends presence (cursor, selection) at most 20 times a second, separately from ops.

**Presence** keeps remote cursors with a target position and a drawn position, lerping each frame, and drops users the server reports as gone.

**React's job** is limited to the toolbar, color picker, share dialog, online-users list, zoom controls and connection status badge ("Reconnecting…"). It subscribes to a few store events, never to every shape change, so React never re-renders 60 times a second.

## WebSocket protocol

All messages are JSON with a `t` (type) field and are validated with Zod on arrival. There are two families: **ops** change the board and are persisted; **presence** messages are ephemeral and never stored.

**Client → server**

| `t` | Payload | Meaning |
| --- | --- | --- |
| `hello` | `boardId, lastSeq` | Join a board; `lastSeq` is the last `upTo` the client received (`0` on first load) |
| `ops` | `ops: Op[]` (each with `opId`, `stamp`) | A batch of create / update / delete / append ops |
| `cursor` | `x, y` (world) | Pointer position, max 20/s |
| `select` | `ids: string[]` | Current selection |
| `typing` | `id` (a note) or `null` | I'm editing this note's text: others show "… is typing" and soft-lock it |
| `ping` | | Heartbeat every 5 s when idle (or when the server has been quiet); answered with `pong` |

**Server → client**

| `t` | Payload | Meaning |
| --- | --- | --- |
| `welcome` | `you, role, peers[], upTo` + either `snapshot` or `ops[]` (catch-up) | Reply to `hello`; `you` and each peer are `{ peerId, userId, name }`. Peers come from every server |
| `ops` | `ops: Op[], upTo` | Ops from other users, delivered as soon as this server has them (in any seq order) |
| `ack` | `opIds[], upTo` | Your ops were accepted and committed to Postgres |
| `saving` | `paused: boolean` | Postgres has been failing for 30 s: this server stops accepting ops (`true`) until a commit succeeds again (`false`). Edits stay pending; on `false` the client resends them |
| `reject` | `opId, reason, shape` | Op refused; `shape` is the server's stored registers for that shape (values *with* their stamps, in snapshot form) or `null` if the server has no such shape. See "Rollback" below |
| `peer-join` / `peer-leave` | `peer { peerId, userId, name }` / `peerId` | Online list changes |
| `cursors` | `cursors: { peerId, x, y }[]` | Other users' latest cursors, batched: one message per socket every 50 ms (a socket's own cursor may be included; clients ignore it) |
| `select` | `peerId, ids` | Another user's selection |
| `role` | `role` | Your role on this board changed (owner changed it over REST). Applies to your next batch; no reconnect |
| `typing` | `peerId, id` | Another peer started (`id`) or stopped (`null`) editing a note |
| `pong` | | Reply to `ping`. A client that hears nothing at all for three heartbeats treats the socket as dead and reconnects |
| `error` | `code, message` | e.g. `forbidden`, `board_not_found`; socket then closes |

**Op shape** (defined in `shared/types.ts`):

```ts
type Op =
  | { kind: 'create'; opId: string; stamp: Stamp; shape: Shape }
  | { kind: 'update'; opId: string; stamp: Stamp; id: string; props: Partial<Shape> }
  | { kind: 'append'; opId: string; stamp: Stamp; id: string; chunk: number; points: number[] };
// delete = update { deleted: true }
// append: `chunk` is the author's per-stroke chunk number (0, 1, 2...); see algorithms.md §7a
```

**The `upTo` watermark.** Every `ops`, `ack` and `welcome` carries `upTo`: the highest seq up to which this server has delivered every op to its sockets, with no gaps (a seq missing for 5 s is skipped as a hole, see "Gap detection"). Clients store the latest `upTo` they received as their `lastSeq`; they never look at op seqs and need no gap detection of their own. Delivery itself is never held back: ops reach sockets the moment the server has them, in whatever order, because LWW converges in any delivery order. Only catch-up depends on order, and the watermark is what makes it safe: a client that saw seq 12 but not 11 still has `lastSeq` 10 or less, so catch-up resends 11.

**Catch-up on reconnect.** `hello` carries the client's `lastSeq` (its last `upTo`). Each room keeps the ops after its previous snapshot in memory (the same range Postgres still has). If that log covers `lastSeq`, `welcome` carries `ops` (only what was missed, applied on top of the client's existing board, then the client resends its pending ops); otherwise `welcome` carries a full `snapshot`, onto which the client reapplies its pending ops. A snapshot is also sent on a first join (`lastSeq = 0`), when `lastSeq` is still ahead of this server after it tried to fill in (below), and when tombstones were garbage-collected after `lastSeq` (the client may still hold one no op will ever mention again). Browsers close the socket on the `offline` event and reconnect on `online`.

A client can reconnect to a different server whose watermark is behind its `lastSeq` (that server hasn't received some ops through Redis yet). Before sending `welcome`, the room reads the missing seqs from Postgres and waits for its watermark to reach `lastSeq`, up to 6 s. Without this, the client's next edit to a shape it created on the other server could be rejected as `unknown_shape`, and the shape would vanish from its screen until the op arrived.

**Offline queue** (`client/src/sync/OfflineQueue.ts`). Every time the set of unacked ops changes, the client writes it to IndexedDB (write-behind: at most one write in flight, the newest set always lands; an empty set deletes the record). Rules:

- One queue per tab: the key is `boardId:tabId`, with the tab ID in `sessionStorage` (it survives a reload of that tab and differs between tabs), so two tabs on one board never overwrite each other's queue. A duplicated tab, which copies `sessionStorage`, notices its ID is taken and picks a new one.
- Each open tab holds a Web Lock (`navigator.locks`) named after its queue; the browser releases it when the tab closes or reloads. On load, a tab takes its own lock, then adopts every queue for this board whose lock it can take (its own from before the reload, and those of closed tabs). It writes the adopted ops into its own queue before deleting the orphans' records, so a crash in between leaves duplicates, never a loss. Duplicates are harmless: the server dedupes by `opId`.
- Each queue stores its `userId`; a queue left by a different user is deleted, never sent.
- Restored ops are sorted by stamp (creates come before later edits of the same shape), the clock observes every stamp, and they are applied and queued before the tab can edit or connect: the UI stays read-only until then. They go out with the first `welcome`.
- A queue is cleared when the board is deleted (4004) or the user is removed from it (4003); after a policy violation (1008) it stays, and a reload sends it.
- No service worker: a reload while offline shows the browser's offline page. The queue survives it, and the next load of the board, once online, sends the ops.

**Presence identity.** Presence is per connection, not per user: every socket gets a server-assigned `peerId`, sent with its `userId` and display name. The same person with two tabs open shows two cursors (one per tab), while online lists group entries by `userId`, so they appear once. Peers are dropped when their socket closes or after 15 s without any message (clients send `ping` every 5 s when idle).

**Close codes.** After a socket has been accepted, the server closes it with: `1008` for a protocol violation (malformed message, ops before `hello`), `4001` when the session was logged out (from any tab, on any server), `4003` when the user was removed from the board, `4004` when the board was deleted. `1013` (try again later) when the server can't reach Redis to sequence ops: that one is retried. The client never reconnects after these; any other close (network drop, server restart, `1012` service restart) is retried with backoff. Authentication failures happen earlier, as HTTP 401/403 on the upgrade, so no socket exists to close.

**Rollback.** The rejected op was applied optimistically with a fresh stamp, newer than anything the server holds, so merging the server's values with LWW would keep the bad value. The client instead overwrites that one shape with the server's registers (or removes it if `shape` is `null`). It then re-applies its other still-unacked ops for the same shape, because the server's copy predates them (they may have been sent later in the same batch). If one of those is rejected too, its own reject rolls it back in turn.

**Sizes and limits**

- Max message size 256 KB; max 100 ops per batch; max 2,000 points per stroke append.
- A client sending more than 200 ops/s is throttled, then disconnected. The budget is per user across all servers (a token bucket in Redis), as is the cap of 5 open sockets.
- Coordinates are rounded to 2 decimals before sending to keep messages small.

**Why JSON and not binary:** easy to debug in DevTools. MessagePack is the easy upgrade later, typically 30–50% smaller.

## Server design

Each server process keeps an in-memory **Room** per active board: the board state, the connected sockets and an op pipeline. Rooms on different servers stay in sync through Redis pub/sub, and every op is written to Postgres before it is acknowledged.

**RoomManager**

- `getRoom(boardId)`: returns the room, loading it on first use (latest snapshot + ops after it from Postgres).
- Subscribes to Redis channel `board:{id}` when a room loads; unsubscribes when it unloads.
- Unloads a room 60 s after its last socket leaves (so a page refresh doesn't reload it).

**Op pipeline (per incoming `ops` batch)**

1. **Parse** with Zod; malformed → `error` and close.
2. **Authorize:** the socket's role must be owner or editor; viewers get `reject`. While saving is paused (see "Postgres slow or down"), the batch is dropped unapplied: no ack and no reject, so the client keeps it pending.
3. **Validate:** shape IDs exist for updates and appends, otherwise `reject` (the server never buffers ops waiting for a create; only clients do); sizes within limits; `append` only by the stroke's creator.
4. **Sequence:** one Redis call reserves n sequence numbers (a Lua script around `INCRBY seq:{boardId} n` that first raises the counter to the highest seq this room has seen, so a lost or reset counter never hands out a used seq). Replies come back in request order, so batches from one socket still apply in order. The batch is validated again after the await; an op that fails then is rejected and its seq is published as a `skip`, so no server waits 5 s for it.
5. **Apply** to the room's in-memory board (LWW from `shared`).
6. **Persist:** hand to OpWriter; wait for the batched INSERT to commit.
7. **Ack** the sender with the op IDs and highest seq.
8. **Broadcast** to the other local sockets in the room, and **publish** to `board:{id}` so other servers relay it to theirs.

Waiting for the commit before acking (step 6 → 7) is what makes "no acknowledged op is ever lost" true. Others' screens are updated in parallel with persistence (step 8 runs right after step 5), so peers don't feel the database latency.

**OpWriter** collects ops from all rooms and flushes every 50 ms or 200 ops as one multi-row INSERT, then resolves the waiting acks. One INSERT per 50 ms instead of one per op keeps Postgres load low.

**Receiving from Redis:** a server ignores messages it published itself (each message carries `serverId`), applies the rest to its local room with LWW and forwards them to its local sockets right away. Every server's copy of a board converges for the same reason clients do. Messages on `board:{id}`: `ops` (with each op's seq and author), `skip` (reserved seqs that will never have an op), `role` / `removed` / `deleted` (REST changes that must reach sockets on every server).

**Resends that land on another server.** A client whose ack was lost reconnects, perhaps to another server, and resends. If that server knows the op only from Redis, it acks once the op is in Postgres (normally within ~100 ms). If it still isn't there after 5 s, the server that sequenced it died before committing; the op is then treated as new (fresh seq, applied again, which is idempotent). A seq collision in Postgres (a reset Redis counter racing an in-flight op) isn't acked either: the client resends and the op gets a new seq.

**Loading a room on a second server.** The server subscribes to `board:{id}` first (buffering messages), then reads snapshot + tail from Postgres, then reads the Redis counter: any seq up to it that Postgres doesn't have yet is a gap for the filler below, and the buffered messages are applied last. No op can fall between the read and the subscription.

**Snapshotter**

- Triggered every 500 ops or 60 s of activity per board, and when a room unloads.
- Takes a Redis lock `snap-lock:{boardId}` (`SET NX PX 30000`, released only by its holder) so only one server snapshots a board at a time; a server that doesn't get it skips this round.
- Snapshots the room's state at its watermark `upTo`: the state may contain later ops too (applied out of order), which is harmless because loading re-applies them idempotently.
- Writes `board_snapshots(board_id, seq, state)` and deletes ops older than the previous snapshot to cap table growth.
- Tombstone GC: drops tombstones older than `TOMBSTONE_TTL_MS` (24 h by default). A tombstone's age is the server's commit time of the op that set `deleted: true` (`board_ops.created_at`), so `shared` never needs wall-clock time.

**Presence** never touches Postgres. Cursor, select and typing messages, joins and leaves are sent to local sockets and published on a separate channel `presence:{boardId}`. The online list lives in a Redis hash `online:{boardId}`, one field per connection (`peerId` → `{ userId, name, serverId, lastSeen }`), because presence is per connection (two tabs = two cursors). `welcome` lists the peers from that hash. Each server refreshes `lastSeen` for its own sockets every 5 s; a sweep removes entries older than 15 s, which is how the peers of a crashed server disappear, and the server whose `HDEL` succeeded publishes their `peer-leave`.

**Why rooms hold state in memory:** validating an update needs the current shape (does it exist? who created this stroke?). Reading Postgres for every op would be far too slow; the in-memory board answers instantly.

## Data model

Postgres stores users, boards, membership and the board history (op log + snapshots). Redis stores only things that can be rebuilt or are temporary: sequence counters, presence and locks.

**Postgres**

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE boards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL DEFAULT 'Untitled board',
  owner_id    UUID NOT NULL REFERENCES users(id),
  link_role   TEXT,                          -- NULL = link sharing off; 'viewer' | 'editor'
  link_token  TEXT UNIQUE,                   -- random, part of the share URL
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ                    -- soft delete
);

CREATE TABLE board_members (
  board_id  UUID NOT NULL REFERENCES boards(id),
  user_id   UUID NOT NULL REFERENCES users(id),
  role      TEXT NOT NULL,                   -- 'owner' | 'editor' | 'viewer'
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE board_ops (
  board_id    UUID   NOT NULL,
  seq         BIGINT NOT NULL,
  op_id       TEXT   NOT NULL,
  user_id     UUID   NOT NULL,
  op          JSONB  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, seq),
  UNIQUE (board_id, op_id)                   -- resent ops are not stored twice
);

CREATE TABLE board_snapshots (
  board_id    UUID   NOT NULL,
  seq         BIGINT NOT NULL,               -- covers all ops with seq <= this
  state       JSONB  NOT NULL,
  shape_count INT    NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, seq)
);
```

`UNIQUE (board_id, op_id)` makes resends safe: a client that never got its ack resends the op, the insert hits the conflict, and the server acks with the original seq instead of storing a duplicate.

**Redis keys**

| Key | Type | Lifetime | Purpose |
| --- | --- | --- | --- |
| `seq:{boardId}` | Integer | Permanent (rebuilt from Postgres max seq if lost) | Next sequence number |
| `board:{boardId}` | Pub/sub channel | While any server has the room loaded | Op fan-out between servers |
| `presence:{boardId}` | Pub/sub channel | Same | Cursor and selection fan-out |
| `online:{boardId}` | Hash peerId → `{ userId, name, serverId, lastSeen }` | Entries swept after 15 s | Online list (per connection) |
| `snap-lock:{boardId}` | String (holder's serverId) | 30 s | One snapshotter at a time |
| `rl:ws:{userId}` | Hash `{ tokens, at }` | 1 min | Op token bucket per user, across servers |
| `sockets:{userId}` | Hash connId → expiry | Entries expire 15 s after their server last refreshed them | Max 5 open sockets per user, across servers |
| `revoked:{jti}` | String | Until the JWT would expire | Logged-out sessions |
| `sessions` | Pub/sub channel | Always | "Close every socket of session `jti`" (logout) |
| `rl:auth:*` | (from @fastify/rate-limit) | 1 min | Login/signup limit per IP, across servers |

Redis runs with AOF persistence (`appendonly yes`) so a restart keeps the seq counters; the floor in the seq script covers the case where one is lost anyway.

**Size estimate.** A typical op is about 150 bytes as JSON. A busy 1-hour session with 10 people produces roughly 50,000 ops, about 7.5 MB, before compaction. Snapshots of a 2,000-shape board are about 0.5–1 MB. Deleting ops older than the previous snapshot keeps each board to a few MB, well within free Postgres tiers.

## REST API

REST handles everything that isn't live editing: accounts, the board list and sharing. All board content goes through the WebSocket.

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/auth/signup` | none | Create account; sets JWT cookie |
| `POST /api/auth/login` | none | Sets JWT cookie (httpOnly, SameSite=Lax, 7 days) |
| `POST /api/auth/logout` | user | Revokes the session (its `jti` goes into Redis until the JWT expires) and clears the cookie; that session's sockets on every server close with `4001` |
| `GET /api/me` | user | Current user |
| `GET /api/boards` | user | Boards I own or am a member of, newest first |
| `POST /api/boards` | user | Create board; caller becomes owner |
| `PATCH /api/boards/:id` | owner | Rename |
| `DELETE /api/boards/:id` | owner | Soft delete; open sockets get `error: board_deleted` |
| `GET /api/boards/:id/members` | member | List members and roles |
| `POST /api/boards/:id/members` | owner | Add member by email with a role |
| `PATCH /api/boards/:id/members/:userId` | owner | Change role; pushed to their open sockets immediately |
| `DELETE /api/boards/:id/members/:userId` | owner | Remove; their sockets are closed |
| `GET /api/boards/:id/link` | owner | Current share link: `{ role, token }` or `null` |
| `PUT /api/boards/:id/link` | owner | `{ role }` with `viewer`, `editor` or `null`: turn link sharing on (new token), change its role (new token) or off; rotating invalidates the old link |
| `POST /api/join/:linkToken` | user | Adds the caller as a member with the link's role (never lowers an existing role); returns the board |
| `GET /api/health` | none | Postgres + Redis reachable |

**Role changes reach live sockets** through a Redis message on `board:{id}` of type `role` (and `removed`, `deleted`), so a demoted editor's next op is rejected even if they're connected to a different server.

## Failure handling and recovery

The design rule is simple: an op is safe once the client has an ack, and anything not yet acked stays in the client's pending queue and is resent. Every failure below reduces to that.

| Failure | What happens | Recovery |
| --- | --- | --- |
| Client Wi-Fi drops for seconds | Socket closes; user keeps drawing locally | Reconnect with backoff, `hello { lastSeq }`, receive missed ops, resend pending ops |
| Client offline for a long time | Pending queue grows, also saved in IndexedDB | Same as above; if too far behind, server sends a fresh snapshot and the client reapplies its pending ops on top |
| Browser tab closed or reloaded with unacked ops | They stay in the tab's IndexedDB queue, whose Web Lock the browser releases | The next load of the board (that tab after a reload, or any new tab) adopts the queue and sends the ops; the server dedupes by `opId` |
| Server process crashes | Sockets drop; unflushed OpWriter batch is lost | Those ops were never acked, so clients resend them to whichever server they reconnect to |
| Server restarts / deploys | Rooms unload | Rooms reload from snapshot + op log on first `hello` |
| Redis restarts | Pub/sub drops messages for a moment; with AOF the counters survive | The seq script never hands out a seq below the highest one the room has seen; lost messages are gaps, filled from Postgres. While Redis is down, batches can't be sequenced: the socket is closed with 1013 and the client retries. The session check fails closed (503 on REST and on the upgrade) |
| Pub/sub message lost between servers | Rooms on two servers briefly differ | Each server compares the seq it receives with the last it saw; a gap triggers a reload of the missing ops from Postgres |
| Postgres slow or down | OpWriter flush fails | Retry with backoff; no acks are sent, so clients keep ops pending. Live relay to peers continues. If it lasts over 30 s (`SAVE_PAUSE_AFTER_MS`), the server sends `saving { paused: true }` and drops new batches unapplied (clients keep them pending and show "Saving paused"); the first successful commit sends `paused: false` and clients resend everything pending |
| Same op received twice | Client resent after a lost ack | `UNIQUE (board_id, op_id)` + LWW idempotency: no duplicate, ack with the original seq |

**Gap detection** is the one subtle piece. Seq numbers are assigned per board and normally have no gaps, so if a server's watermark is at 120 and it receives 123, it knows 121–122 are missing. It delivers 123 to its sockets immediately (LWW doesn't care about order) but keeps its watermark at 120, and reads 121–122 from Postgres every 250 ms until they appear; each one found is applied, delivered and moves the watermark on. Clients do no gap detection: they only store the watermark (`upTo`) the server sends, which by construction never skips an op. Snapshots are taken at the watermark too, so a snapshot never silently misses an op. One catch: a server can reserve a seq and then crash before publishing or writing it, leaving a permanent hole. If a missing seq still isn't in Postgres after 5 seconds, the watermark moves past it; its op was never acked, so its author resends it with a new seq.

**Why delivery isn't held back.** Holding out-of-order ops until the gap is filled would make catch-up simpler to reason about, but it would delay every live edit on the board behind one lost or slow message, by up to 5 s for a crashed server's hole. LWW already converges in any delivery order, so only the catch-up bookkeeping needs order, and the watermark gives it that without touching live latency.

**Graceful shutdown:** on SIGTERM, stop accepting new sockets, flush OpWriter, snapshot every loaded room, then close sockets with code 1012 (service restart) so clients reconnect immediately instead of waiting for backoff.

## Security

The server trusts nothing a client sends: every socket is authenticated at the upgrade, and every op is authorized and validated before it is applied or relayed.

- **WebSocket auth:** the upgrade request carries the JWT cookie. The server verifies it and the user's role on the board *before* accepting the upgrade; failures get HTTP 401/403 and no socket.
- **Origin check:** reject upgrades whose `Origin` header isn't the app's domain. Cookies are sent cross-site on WebSocket upgrades, so without this any website could open a socket as the logged-in user (cross-site WebSocket hijacking).
- **Per-op authorization:** role checked on every batch, since roles can change while a socket is open.
- **Validation:** Zod schemas for every message; numbers must be finite; strings and point arrays have maximum lengths; unknown fields are stripped.
- **Ownership rules:** only a stroke's creator may `append` to it; clients cannot set `seq` or forge another user's ID (the server attaches `userId` from the socket).
- **Rate limits:** ops per user per second (Redis token bucket, shared by all servers), messages per socket per second, max open sockets per user (5, counted in Redis across servers), login/signup per IP (Redis store).
- **Sessions:** each JWT has a random `jti`. Logout stores it in `revoked:{jti}` until expiry and publishes on `sessions`, which closes that session's sockets everywhere (4001). REST and the WebSocket upgrade check the revocation list on every request and fail closed: if Redis is unreachable they answer 503 rather than accept a possibly revoked session (the app needs Redis for seqs anyway).
- **XSS:** canvas drawing can't inject HTML, but note text is also shown in the textarea overlay and user names in the online list. Always set them via `textContent` / React, never `innerHTML`.
- **Passwords:** bcrypt with cost 12; login rate-limited per IP.
- **Share links:** 32-byte random tokens (base64url); turning the link on, changing its role or turning it off rotates or removes the token, which invalidates the old link. Joining never lowers an existing member's role and never makes anyone owner.

## Testing, metrics and load tests

The randomized convergence test proves the algorithms are correct; the load test produces the numbers for the resume. Build both.

**Randomized convergence test** (the most important test)

1. Create N simulated clients (say 5), each with its own `shared/board` copy and Lamport clock.
2. For 1,000 rounds, a random client makes a random op (create, move, recolor, delete, reorder, stroke append, stroke finalize) on a random shape.
3. Deliver ops to other clients **in random order, with random delays and random duplicates**.
4. After all ops are delivered, assert every client's board is deep-equal.
5. Run with 500 different random seeds; print the seed on failure so the bug is reproducible.

This runs in plain Node in a few seconds because `shared` has no DOM or network dependencies.

**Other tests**

| Level | What | Tool |
| --- | --- | --- |
| Unit | `keyBetween`, `rdp`, `distToSegment`, quadtree insert/query/remove, camera maths, undo inverses | Vitest |
| Server integration | `hello` → `welcome`, viewer gets `reject`, duplicate op acked once, reload from snapshot + ops | Vitest + real Postgres/Redis in Docker |
| End-to-end | 3 browser contexts on one board: draw in one, assert it appears in the others; go offline in one, edit, reconnect, compare | Playwright |
| Chaos | Kill the server mid-session; restart; assert no acked op is missing | Script + Playwright |

**Metrics** (logged and exposed on `/metrics`)

- `op_relay_ms`: server receive → peers sent (histogram)
- `op_commit_ms`: receive → Postgres commit → ack (histogram)
- `ws_connections`, `rooms_loaded`, `ops_per_second`
- `snapshot_ms`, `board_load_ms`
- `catchup_ops`: how many ops a reconnecting client needed

**Load test**

- A Node script opens N bot clients on one board over `ws`. Each bot moves a random shape every 200 ms and sends a cursor every 50 ms.
- Every op carries the sender's send time; receiving bots record `receive − send` (bots run on one machine, so clocks agree).
- Ramp N: 10, 20, 30, 50 bots. Record p50/p95 end-to-end latency, server CPU and ops/s.
- Repeat with 2 server processes behind a local load balancer (nginx) to show Redis fan-out works.

**Numbers to put on the resume:** max editors per board at p95 under 150 ms, ops/s one server sustains, board load time at 10,000 shapes, and "0 divergences across 500 randomized runs."

## Build order

Milestones are built in this order; each ends with something that runs. The checklist in `CLAUDE.md` ("Current status") is the source of truth for progress.

1. **Shared core:** monorepo, TypeScript, Vitest, Docker Compose; Lamport clock, LWW board with tombstones and stroke chunks, `keyBetween`; randomized convergence test passing for 500 seeds.
2. **Canvas basics:** renderer with render loop, dirty flags, devicePixelRatio; camera with pan, zoom-to-cursor, `toWorld`/`toScreen`; draw rectangles, ellipses and arrows from a local BoardStore.
3. **Tools and interaction:** quadtree, viewport culling, hit testing; select tool (click, box-select, drag, resize, delete); shape tools, color picker, bring to front / send to back.
4. **Server and sync:** Fastify + `ws`, Room, RoomManager (in memory, single server); protocol schemas; `hello`/`welcome`, `ops`, `ack`, broadcast; SyncClient with pending queue; two tabs editing one board.
5. **Persistence and auth:** Postgres schema, migrations, OpWriter, ack after commit; Snapshotter and load from snapshot + ops; signup/login, boards list, JWT on the WebSocket upgrade, roles; reconnect with backoff and resend of pending ops (pulled forward from milestone 7: without it an unacked edit is lost when the server restarts).
6. **Freehand and presence:** pen tool with chunked appends, RDP, Bézier smoothing; eraser; live cursors with interpolation, selections, online list, heartbeats.
7. **Undo, notes, catch-up:** per-user undo/redo with inverse ops; sticky notes with textarea overlay; `lastSeq` catch-up on reconnect; tombstone GC at snapshot time (age from `board_ops.created_at` of the delete op).
8. **Scale out and harden:** Redis pub/sub between 2 server processes, `INCR` seq, gap detection; sharing dialog and link tokens; rate limits; origin check; graceful shutdown.
9. **Tests and numbers:** Playwright 3-browser test, chaos test, load test at 10/20/30/50 bots; fix what the tests find.
10. **Ship:** deploy to free tiers; README with architecture diagram, algorithm list and measured results; 60-second demo video.

**If time runs short,** cut in this order: multi-server Redis (describe it instead), share links (keep member invites), Playwright tests (keep the convergence test). Never cut the convergence test or the load-test numbers.
