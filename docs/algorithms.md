# Collaborative Whiteboard — Algorithms Deep Dive

Every algorithm the whiteboard needs, explained from scratch with examples and TypeScript code. Code here is reference/pseudocode: the real implementation lives in `packages/shared` and `packages/client`, and must follow the rules in `CLAUDE.md`.

## The big picture

Every algorithm in this doc serves one goal: every screen shows the same board, and your own edits never wait for the network.

One edit, from sender to receiver:

```
Rudraksh's browser              WebSocket server               Priya's browser
1. Drag creates an x,y update   5. Check edit permission       9.  Advance Lamport clock
2. Stamp with Lamport clock --> 6. Assign seq, append to log -->10. LWW: newer stamp wins
3. Apply locally, redraw now    7. Publish via Redis           11. Update the quadtree
4. Add to pending queue    <--  8. Ack sender, broadcast       12. Redraw
                       (ack)         |
                                     v
                              Redis + Postgres
                              Pub/sub to other servers
                              Op log and snapshots
```

Steps 1–4 happen before any network traffic, which is why drawing feels instant. Steps 9–12 run identically on every other client, which is why all screens converge. Sections 1–6 explain the sync steps; 7–11 are drawing and interaction; 12 is the server side.

## 1. Data model, IDs and operations

The board is a map from shape ID to shape, and every change is one of a few small operations: create, update (delete is an update) or append. Everything else in this doc builds on these two ideas.

**Why a map and not a list.** In a text editor, character 5 depends on characters 1–4. On a whiteboard, a rectangle doesn't care where the arrow is. Storing shapes in a map keyed by ID means a change to one shape never shifts or renumbers another. That independence is what makes whiteboard sync easier than text sync.

```ts
type ShapeId = string;          // "k3f9a-17" = clientId + "-" + counter

interface Shape {
  id: ShapeId;
  type: 'rect' | 'ellipse' | 'arrow' | 'stroke' | 'note';   // note = sticky note, content in `text`
  x: number; y: number;          // world coordinates (section 10)
  w: number; h: number;
  color: string;
  z: string;                     // fractional index (section 5)
  points?: number[];             // strokes only, final simplified list: [x1, y1, x2, y2, ...]; set only at pen-up;
                                 // relative to the stroke's x, y (section 7a)
  text?: string;
  deleted?: boolean;             // tombstone (section 4)
}

type Board = Map<ShapeId, Shape>;
```

**Generating IDs without asking anyone.** When a browser tab opens, it makes a random `clientId` (8 characters is plenty). It then numbers its own shapes 1, 2, 3… The ID is `clientId-counter`.

- Two clients never clash: their `clientId` parts differ.
- One client never clashes with itself: its counter only goes up.
- No server round trip: you can draw instantly, even offline.

```ts
const clientId = crypto.randomUUID().slice(0, 8);
let seq = 0;
const newId = () => `${clientId}-${++seq}`;
```

**The operations.** A user action is turned into one or more of these and sent over the WebSocket:

```ts
type Op =
  | { kind: 'create'; opId: string; stamp: Stamp; shape: Shape }
  | { kind: 'update'; opId: string; stamp: Stamp; id: ShapeId; props: Partial<Shape> }
  | { kind: 'append'; opId: string; stamp: Stamp; id: ShapeId; chunk: number; points: number[] };
// delete = update { deleted: true }
```

`Stamp` is the logical timestamp from section 2. `append` is explained in section 7a.

**Property-level updates remove most conflicts.** An update carries only the fields that changed. Example: Rudraksh drags a box (`{x, y}`) while Priya recolors it (`{color}`). The two updates touch different fields, so both apply cleanly. The box ends up moved and recolored, with no conflict to resolve. Real conflicts only happen when two people change the **same field of the same shape** at nearly the same moment, which sections 2 and 3 handle.

**Batching.** Dragging fires 60 mouse events a second. Don't send 60 ops. Collect changes and flush every 30–50 ms, merging updates to the same shape (`{x:101}` then `{x:104}` becomes just `{x:104}`). This cuts traffic by over 90% and nobody notices the delay.

**Interview point:** "I used property-level operations on a map of independently addressable objects, so most concurrent edits commute and never conflict." *Commute* means the order of applying them doesn't matter.

## 2. Lamport clocks: agreeing on "later"

A Lamport clock is a counter that guarantees one thing: if you saw someone's change before making yours, your change gets a bigger number. That is exactly the meaning of "later" that conflict resolution needs.

**Why not use the real time?** Every laptop's clock is slightly wrong. If Priya's clock runs 3 minutes fast, every edit she makes looks "newer" than Rudraksh's, even ones she made before seeing his. Her stale edits would keep overwriting his fresh ones. You can't trust clocks across machines, so you build your own notion of order.

**The two rules**

1. **Before sending a change:** `clock = clock + 1`, and stamp the change with `clock`.
2. **On receiving a change stamped `t`:** `clock = max(clock, t)`. (Some versions add 1 here too; either works as long as rule 1 still adds 1 before every send.)

**Worked example**

| Step | What happens | Rudraksh's clock | Priya's clock | Stamp |
| --- | --- | --- | --- | --- |
| 1 | Start | 0 | 0 | |
| 2 | Rudraksh moves the box | 1 | 0 | (1, rudraksh) |
| 3 | Rudraksh moves it again | 2 | 0 | (2, rudraksh) |
| 4 | Priya receives both | 2 | 2 | |
| 5 | Priya recolors the box | 2 | 3 | (3, priya) |
| 6 | Rudraksh receives it | 3 | 3 | |
| 7 | Both change `x` at the same instant | 4 | 4 | (4, rudraksh) and (4, priya) |

At step 5, Priya had seen Rudraksh's moves, and her stamp 3 is larger than his 2. At step 7 neither saw the other's change, so both stamp 4: a tie.

**Breaking ties.** Compare the client IDs. Any fixed rule works, as long as every client uses the same one. Here, `"rudraksh" > "priya"` alphabetically, so Rudraksh wins step 7 on every screen.

```ts
interface Stamp { t: number; client: string }

let clock = 0;
const tick = (): Stamp => ({ t: ++clock, client: clientId });
const observe = (s: Stamp) => { clock = Math.max(clock, s.t); };

// > 0 means a is later than b
const compare = (a: Stamp, b: Stamp) =>
  a.t !== b.t ? a.t - b.t : a.client < b.client ? -1 : a.client > b.client ? 1 : 0;
```

**What Lamport clocks do NOT tell you.** If stamp A < stamp B, it does *not* mean A actually happened first in real time. It only means the system will *treat* A as first, and everyone agrees on that. When neither person saw the other's change, the edits were truly concurrent, and the tie-break picks a winner arbitrarily but consistently. For a whiteboard that's fine: two people dragging the same box at the same moment have no "correct" answer anyway.

**Where the clock lives.** Each client keeps its own. Call `observe` on every op received from the server, including ones loaded from a snapshot on page load, so a reloaded tab never stamps edits with numbers lower than what's already on the board.

**Interview point:** "Wall clocks drift, so I used Lamport timestamps with client-ID tie-breaks to get a total order every replica agrees on." If asked about vector clocks: they can detect concurrency (whether two edits saw each other), but cost one counter per client. LWW only needs a total order, so Lamport is enough.

## 3. Last-Writer-Wins (LWW) registers

Each property of each shape remembers the stamp of its last change; an incoming change is applied only if its stamp is later. Because every client runs the same comparison, every screen ends with the same values, whatever order messages arrive in.

**A register** is just "a box holding one value." An LWW register holds a value plus the stamp of whoever wrote it last:

```ts
interface Reg<T> { value: T; stamp: Stamp }

// A shape stored with one register per property
type StoredShape = { id: ShapeId } & { [prop: string]: Reg<unknown> };
```

**Applying an update**

```ts
function applyUpdate(board: Map<ShapeId, StoredShape>, op: UpdateOp) {
  observe(op.stamp);                       // keep the Lamport clock moving
  const shape = board.get(op.id);
  if (!shape) return bufferForLater(op);    // create hasn't arrived yet
  for (const [prop, value] of Object.entries(op.props)) {
    const cur = shape[prop];
    if (!cur || compare(op.stamp, cur.stamp) > 0) {
      shape[prop] = { value, stamp: op.stamp };   // newer: take it
    }                                              // older: ignore it
  }
}
```

**Why order of arrival doesn't matter.** Say A = `{x: 300}` stamped (5, rudraksh) and B = `{x: 500}` stamped (5, priya).

- Client 1 receives A then B: takes A (field was empty), then compares B to A. B loses the tie-break, so it is ignored. Result `x = 300`.
- Client 2 receives B then A: takes B, then compares A to B. A wins the tie-break and replaces it. Result `x = 300`.

Same answer both ways. Formally, the merge is **commutative** (order doesn't matter), **associative** (grouping doesn't matter) and **idempotent** (receiving the same op twice changes nothing). Any data structure with these three properties is a **CRDT**, so an LWW map is a simple CRDT.

**Idempotency in practice.** WebSocket reconnects often resend ops. Because a duplicate has the same stamp, `compare` returns 0 and it's ignored. You get safe retries for free.

**The downside of LWW.** One person's change is silently discarded. For a box's position, that's fine: the box was moved, just not to their spot, and they see it immediately. It is *not* fine for long text where two people typed different sentences, since one person loses their typing. That's why text inside shapes is the one place LWW is weak (section 13 covers it).

**Updates that arrive before their create.** Normally the server relays ops in order, but after reconnects or offline sync an update can show up first. Hold it in a small buffer per ID and apply it when the create arrives. Appends are buffered the same way.

- **No time-based expiry.** If one replica discarded a buffered op after a minute and another kept it, they would diverge for good once the create arrived. Buffered ops simply wait.
- **Cleared on a fresh snapshot.** Loading a full snapshot (section 12b, "too far behind") replaces the board and empties the buffer.
- **Size cap.** At most 10,000 buffered ops per board; beyond that the oldest is dropped and a warning is logged. Hitting the cap means a bug or abuse, not normal traffic.
- **Clients only.** The server never buffers: it rejects updates and appends for shapes it doesn't know, since it applies ops in the order it receives them and a create must already be in its log.

**Interview point:** "Each property is an LWW register keyed by a Lamport stamp. Merge is commutative, associative and idempotent, so it's a state-based CRDT and replicas converge regardless of delivery order or duplicates."

## 4. Deletes, tombstones and garbage collection

A deleted shape is never removed right away; it is marked `deleted: true` (a tombstone) so late updates still find it and every client reaches the same answer. Tombstones are cleaned up later, once nobody can still be sending edits for that shape.

**The problem with really deleting.** Priya deletes a sticky note. Before her delete reaches Rudraksh, he moves the note. Now:

- On Priya's screen the note is gone from the map, so Rudraksh's late move finds nothing. Do you recreate it? Ignore it?
- On Rudraksh's screen, the delete arrives after his move.

Without a clear rule, the two screens can disagree permanently.

**The fix: delete is just another property.** `deleted` is an LWW register like `x` or `color`. Deleting means `update { deleted: true }`. The renderer simply skips shapes where `deleted` is true.

Now decide what the user sees when a delete and an edit race. The safe rule is: **keep applying every update with normal LWW, even to deleted shapes, but never draw a deleted shape.** Rudraksh's late move is recorded on the tombstone, so all replicas still hold identical data, and the note stays invisible on every screen. The user experience is "delete wins."

A tempting shortcut is to skip updates to deleted shapes entirely. Don't: a client that received the edit *before* the delete stored it, while a client that received it *after* skipped it. If an undo later restores the shape, the two screens show it in different places. Skipping breaks convergence; hiding doesn't.

Because `deleted` is itself a normal LWW register, undo (section 9) restores a shape by writing `deleted: false` with a newer stamp.

```ts
function applyUpdate(shape: StoredShape, op: UpdateOp) {
  for (const [prop, value] of Object.entries(op.props)) {
    const cur = shape[prop];
    if (!cur || compare(op.stamp, cur.stamp) > 0) shape[prop] = { value, stamp: op.stamp };
  }
}

const isVisible = (s: StoredShape) => s.deleted?.value !== true;  // renderer filter
```

**Why tombstones pile up.** A busy board might delete thousands of strokes (an eraser creates lots of deletes). Each tombstone still costs memory, storage and load time.

**Garbage collection (GC).** You can permanently remove a tombstone once no client could still send an op for it. Two practical rules:

1. **Time-based (simplest):** remove tombstones older than 24 hours when taking a snapshot. Any client offline for longer than that reloads the board from scratch instead of replaying its queue.
2. **Acknowledgement-based (exact):** the server tracks the highest stamp each connected client has confirmed receiving. A tombstone older than the *lowest* of those can go, because every client has already seen it.

Start with rule 1; mention rule 2 in interviews.

**Interview point:** "Deletes are tombstones, i.e. an LWW `deleted` flag, so a delete racing an edit resolves the same way on every replica. Tombstones are garbage-collected at snapshot time after a 24-hour horizon."

## 5. Fractional indexing: who is on top

Each shape's stacking position is a sortable key you can always fit a new key between, so moving one shape up or down changes only that shape. It turns reordering into a single LWW update.

**The naive way breaks.** Give shapes z = 1, 2, 3, 4 and draw in that order. To move shape 4 between 1 and 2, you renumber: 2→3, 3→4, 4→2. That's three updates for one action. If Priya reorders at the same moment, both renumberings collide, and you can end up with two shapes at z = 3.

**The idea: use numbers with room between them.**

| Action | Keys after |
| --- | --- |
| Start | A = 1, B = 2 |
| Put C between A and B | C = 1.5 (midpoint) |
| Put D between A and C | D = 1.25 |
| Bring A to the front | A = 3 (bigger than the max) |

Only the moved shape changes. Rendering means sorting shapes by key and drawing from smallest to largest.

**Why strings instead of decimals.** After about 50 halvings, JavaScript numbers run out of precision and two "different" midpoints become equal. Strings never run out: between `"a"` and `"b"` you can always make `"an"`, between `"a"` and `"an"` you get `"ag"`, and so on, getting longer instead of less precise. Compare keys with plain `<` string comparison (not `localeCompare`, which can sort differently on different machines).

**First attempt: a midpoint-only function** over the alphabet `0-9a-z` (base 36). It works, but it is not what we ship:

```ts
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

// Returns a key strictly between a and b. a = '' means "start", b = '' means "end".
function midpoint(a: string, b: string): string {
  let result = '';
  for (let i = 0; ; i++) {
    const lo = i < a.length ? DIGITS.indexOf(a[i]) : 0;
    const hi = b && i < b.length ? DIGITS.indexOf(b[i]) : DIGITS.length;
    if (hi - lo > 1) return result + DIGITS[Math.floor((lo + hi) / 2)];
    result += DIGITS[lo];   // no room at this position: copy and look one digit deeper
  }
}
// midpoint('', '') = 'i', midpoint('i', '') = 'r', midpoint('i', 'r') = 'm', midpoint('i', 'j') = 'ii'
```

**Why midpoint-only grew too fast.** Every new shape goes on top: `midpoint(top, '')`. Each call halves the gap between the top key and the end of the alphabet (`i` → `r` → `v` → `x` → `y` → `z`), so after about 6 shapes the last digit is `z` and the next key needs one more character. Key length grows linearly with the number of shapes created on top. Measured:

| Shapes created on top | Key length |
| --- | --- |
| 10 | 2 (`zx`) |
| 300 | 50 |
| 1,000 | 167 |
| 20,000 | 3,334 |

Every create op and every snapshot carries these keys, `?demo=20000` took 2.2 s just to seed, and the "rebalance past ~50 characters" fix below would trigger after only 300 shapes of completely normal use.

**What we ship: an integer part plus a fraction** (`packages/shared/src/fractional.ts`, same idea as the `fractional-indexing` npm package, written ourselves):

```
key = integer part        + optional fraction
      head + digits
e.g.  "k" + "a3"          + "i"         ->  "ka3i"
```

- **The head character says how many digits the integer has**, so integers of different lengths still sort correctly as plain strings. Heads `i`..`z` mean 1..18 digits counting up from `i0`: `i0 < i1 < … < iz < j00 < … < jzz < k000`. Heads `h`..`0` mean 1..18 digits counting down below `i0`: `… < gzz < h0 < … < hz < i0`.
- **On top** (`keyBetween(top, '')`): increment the integer and drop any fraction, since a bigger integer beats any fraction. **At the bottom**: decrement it. Keys grow logarithmically: 36 keys fit in 2 characters, 1,296 more in 3, 46,656 more in 4. 20,000 shapes on top (or at the bottom) stay at **4 characters**, against 3,334 before.
- **Between two neighbours**: if the next integer up from `a` is still below `b`, use it; otherwise split the gap with the midpoint function above, applied to the fraction only.
- The first key is `i0`. Edge case still to keep: a fraction must never end in `'0'`, otherwise nothing fits between `"i0k"` and `"i0k0"`.

```ts
keyBetween('', '');       // 'i0'    first shape
keyBetween('i0', '');     // 'i1'    on top of it
keyBetween('iz', '');     // 'j00'   integer of the next length
keyBetween('', 'i0');     // 'hz'    below everything
keyBetween('i0', 'i5');   // 'i1'    a free integer fits between
keyBetween('i0', 'i1');   // 'i0i'   adjacent integers: use a fraction
```

Unit tests cover key length after 20,000 top and 20,000 bottom inserts, inserts between neighbours, and ordering staying correct under 5,000 random top/bottom/between inserts.

**Concurrent inserts at the same spot.** Rudraksh and Priya both drop a shape between `i0` and `i1` at the same moment, and both compute `i0i`. Equal keys would make draw order depend on the client. Fix: sort by `(key, shapeId)`, so the shape ID breaks ties identically everywhere.

**Key growth that remains.** Inserting again and again at the *same* spot between two neighbours still grows the fraction by about one character per 6 inserts (`i0i`, `i0r`, … ); that is inherent to any fractional index. It is rare in practice. If a key passes ~50 characters, rebalance: the server rewrites all keys evenly as one batch of updates.

**Bonus:** the same technique orders anything people reorder together, such as layers, slides or kanban cards. Figma has written publicly about using it.

**Interview point:** "Z-order is a fractional index stored as an LWW property, so reordering is O(1) updates and concurrent reorders never conflict; ties break on shape ID."

## 6. Optimistic updates and server reconciliation

Your own edits are applied to your screen instantly and sent in the background; the server relays them to everyone and, rarely, tells you to undo one. Users feel zero lag, and LWW makes "fixing" a wrong guess trivial.

**Why not wait for the server?** A round trip to a server in another city is roughly 30–80 ms; on mobile data, 150+ ms. If a dragged box only moved after the server replied, it would trail behind the mouse. Every serious collaborative app applies local changes first.

**The flow for one edit**

1. User drags a box. The client creates `update {x, y}` with a fresh stamp.
2. The client **applies it locally** immediately and redraws.
3. The op goes into a **pending queue** and is sent over the WebSocket.
4. The server validates it (is this user allowed to edit? is the shape ID real?), appends it to the board's log, and **broadcasts** it to the other users in the room.
5. The server sends an **ack** back to the sender.
6. On ack, the client removes the op from its pending queue.

```ts
const pending = new Map<string, Op>();     // opId -> op, in send order

function submit(op: Op) {
  applyLocal(op);                // 1-2: instant
  pending.set(op.opId, op);      // 3
  socket.send(JSON.stringify(op));
}

socket.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.ack) pending.delete(msg.ack);                 // 6
  else if (msg.reject) rollback(msg.reject, msg.shape); // rare
  else applyRemote(msg);                                // others' ops, LWW decides
};
```

(The real protocol batches ops and uses the message types in `system-design.md`; this shows the idea.)

**What if a remote op conflicts with my pending one?** Nothing special is needed. Both carry stamps; LWW compares them. If the remote stamp is newer, it overwrites your local value on your screen, exactly as it does on the server and on everyone else's. Your screen "snaps" to the agreed value.

**Rejects and rollback.** The server can refuse an op: a viewer tried to edit, or the op is malformed. It replies with a reject and the server's current version of the shape. The client replaces its local copy with the server's. With LWW stores, rollback is just "accept the server's registers."

**Reconnects.** When the socket drops, keep the pending queue. On reconnect, resend everything still in it. Duplicates are safe because applying the same op twice changes nothing (idempotency, section 3).

**Server-authoritative vs peer-to-peer.** Clients could send ops directly to each other (WebRTC), but a server makes permissions, persistence and history simple. Use a server; mention that the LWW design would also work peer-to-peer.

**Interview point:** "Clients apply ops optimistically and keep a pending queue until the server acks. Because merge is LWW, remote conflicts and rejects reconcile by simply accepting the newer or authoritative registers, with no rebasing logic."

## 7. Freehand drawing: streaming, simplification, smoothing

A pen stroke is a list of points: stream them while drawing so others see the line grow, simplify them with Ramer–Douglas–Peucker when the pen lifts, and draw smooth curves through what's left.

### 7a. Streaming a stroke while it's drawn

The browser fires `pointermove` about 60–120 times a second. Sending each point is wasteful; sending the stroke only at the end means others see nothing for seconds, then a line pops in.

1. **Pen down:** `create` a stroke shape with `points` left unset, plus `append { chunk: 0, points: [first point] }` in the same batch.
2. **While moving:** collect points; every 50 ms send `append { id, chunk, points: [new points only] }`, where `chunk` is the author's per-stroke chunk number (0, 1, 2…).
3. **Pen up:** run RDP (7b) and send one final normal LWW `update { points: simplified }`.

**How appends merge (agreed design):**

- A stroke stores its appended chunks keyed by chunk number. Merging is a **union**: a duplicate chunk changes nothing, and chunks arriving out of order are simply placed by number. So appends are commutative and idempotent, like everything else.
- Only the stroke's author may append (the server enforces this), so two people never write the same chunk.
- **Rendering rule:** if the stroke's `points` register is set (the pen-up update), draw that; otherwise draw the chunks concatenated in chunk-number order.
- **Coordinates are relative.** A stroke's `x, y` is its pen-down point, and every point, in chunks and in `points`, is an offset from it. Moving a stroke is then a plain `update { x, y }` like any other shape, instead of rewriting every point.
- **Bounding box is computed, not stored:** the min/max of the points, offset by `x, y`, plus half the line width (section 11a). A stroke's `w`/`h` are not used.
- **No resizing in v1:** strokes can be moved, recolored and deleted only.
- **`points` is written only at pen-up**, never by the create. If the create set it, the rendering rule would draw just that first point and hide every streamed chunk until pen-up.
- Appends that arrive before their `create` are buffered, the same as updates (section 3).
- The convergence test includes random appends and the pen-up update.

### 7b. Ramer–Douglas–Peucker (RDP) simplification

**The idea in plain words:** if a run of points is nearly a straight line, you only need its two ends.

1. Draw a straight line from the first point to the last.
2. Find the point **farthest** from that line.
3. If that distance is **under ε** (say 1 pixel), every middle point is unnecessary: keep only the two ends.
4. Otherwise keep that farthest point, split the stroke there, and repeat steps 1–4 on each half.

**Example:** a slightly wobbly horizontal line of 100 points has no point farther than 0.6 px from the straight line, so it collapses to 2 points. A letter "V" splits once at the bottom tip, then each arm collapses: 3 points.

```ts
type P = [number, number];

// distance from point p to the line through a and b
function perpDist(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

function rdp(pts: P[], eps = 1): P[] {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return [...left.slice(0, -1), ...right];   // don't repeat the split point
}
```

**Complexity:** O(n log n) on typical strokes, O(n²) in the worst case (when every split peels off just one point). Fine for strokes of a few thousand points. Typical savings: 70–90% fewer points with no visible difference, which means less data sent, stored and hit-tested.

**Choose ε in screen pixels**, then convert to world units by dividing by the zoom level (section 10). Otherwise strokes drawn while zoomed out get simplified too aggressively.

### 7c. Smoothing: curves instead of zigzags

Joining points with straight segments looks jagged. Draw a **quadratic Bézier curve** between the midpoints of neighbouring points, using each real point as the control point. The curve passes smoothly near every point without sharp corners.

```ts
function drawSmooth(ctx: CanvasRenderingContext2D, pts: P[]) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}
```

Smoothing happens only at draw time. The stored and synced data stays the simplified point list, so every client draws the identical curve.

### 7d. The eraser

An eraser checks which strokes the eraser circle touches (hit testing, section 11) and sends `update { deleted: true }` for each one. Erasing *part* of a stroke (splitting it in two) is a v2 feature; whole-stroke erase is what most whiteboards ship first.

**Interview point:** "Strokes stream as append-only point chunks owned by one author and merged as a union, then get simplified with RDP, cutting points by ~80% before persisting. Rendering uses midpoint quadratic Béziers."

## 8. Presence and live cursors

Cursors and "who's online" are temporary data: throttle them to about 20 updates a second, never save them, animate smoothly between updates on the receiving side, and use heartbeats to notice people who left.

**Two kinds of data on a whiteboard**

| | Board data (shapes) | Presence data (cursors, who's online, selection) |
| --- | --- | --- |
| Lifetime | Forever | Only while the user is connected |
| Saved to DB | Yes | Never |
| Conflicts | Resolved by LWW | None: each user only writes their own |
| Lost message | Must be resent | Doesn't matter, the next one replaces it |

Keep presence on a separate message type so the server never logs it. That simplicity is also a scaling win: presence is often more traffic than edits.

**Throttling: send at most every 50 ms.**

```ts
let last = 0, queued: [number, number] | null = null;

function onPointerMove(worldX: number, worldY: number) {
  queued = [worldX, worldY];
  const now = performance.now();
  if (now - last >= 50) {
    socket.send(JSON.stringify({ t: 'cursor', x: queued[0], y: queued[1] }));
    last = now; queued = null;
  }
}
// plus a 50 ms timer that sends `queued` if the mouse stopped mid-interval,
// so the final resting position is always sent
```

Send cursor positions in **world** coordinates (section 10), not screen coordinates. Each viewer converts them to their own screen, so a cursor points at the same shape for everyone regardless of zoom.

**Interpolation: making 20 updates look like 60.** If you jump the cursor to each new position, it moves in visible hops. Instead, each frame move it part of the way toward its latest target:

```ts
// called every animation frame for each remote cursor
c.x += (c.targetX - c.x) * 0.3;
c.y += (c.targetY - c.y) * 0.3;
```

This is called **lerp** (linear interpolation) toward a target. 0.3 means "cover 30% of the remaining distance per frame": fast enough to feel live, smooth enough to hide the gaps.

**Heartbeats: noticing who left.** A closed laptop lid sends no "goodbye."

1. Every client sends `ping` every 5 seconds (any cursor message also counts).
2. The server records `lastSeen[userId]`.
3. A timer removes users not seen for 15 seconds and broadcasts `peer-leave`.

**Selection presence.** When Priya selects a shape, broadcast `{ t: 'select', ids: [...] }` so others see her colored outline around it. This also avoids most conflicts in practice: people tend not to drag a shape someone else is visibly holding.

**Colors.** Hash the user ID to pick from a fixed palette of 8–10 colors, so each person keeps the same color across reloads and every viewer sees the same assignment.

**Interview point:** "Presence is ephemeral and unpersisted, throttled to 20 Hz in world coordinates, interpolated client-side, with heartbeat timeouts for departure detection."

## 9. Multiplayer undo and redo

Ctrl+Z undoes only your own last action, by sending its inverse as a brand-new operation. Other people's work is never touched, and the undo syncs like any other edit.

**Why single-user undo is wrong here.** A normal app keeps one history and pops the latest entry. On a shared board the latest entry might be Priya's. If Rudraksh presses Ctrl+Z and her rectangle vanishes, that's a bug from her point of view.

**Inverse operations.** When you make an edit, record how to reverse it at that moment:

| Your action | What goes on your undo stack |
| --- | --- |
| Create shape S | `update S { deleted: true }` |
| Delete shape S | `update S { deleted: false }` |
| Move S from (100, 50) to (300, 80) | `update S { x: 100, y: 50 }` |
| Recolor S from blue to red | `update S { color: 'blue' }` |
| Move 5 selected shapes | One group entry holding 5 inverse updates, undone together |

Tombstones (section 4) are what make "undo a delete" possible: the shape's data is still there to bring back.

**Undo and redo as two stacks**

```ts
interface Entry { undo: UpdateOp[]; redo: UpdateOp[] }
const undoStack: Entry[] = [];
const redoStack: Entry[] = [];

function record(forward: UpdateOp[], inverse: UpdateOp[]) {
  undoStack.push({ undo: inverse, redo: forward });
  redoStack.length = 0;               // a new action clears redo
}

function undo() {
  const e = undoStack.pop(); if (!e) return;
  e.undo.forEach(op => submit({ ...op, stamp: tick() }));  // fresh stamp
  redoStack.push(e);
}

function redo() {
  const e = redoStack.pop(); if (!e) return;
  e.redo.forEach(op => submit({ ...op, stamp: tick() }));
  undoStack.push(e);
}
```

**Why a fresh stamp matters.** The undo must beat the value it's undoing. Reusing the old stamp would make it lose under LWW and do nothing. A new `tick()` makes it the newest write.

**The tricky case: someone changed it after you.** Rudraksh moves a box to (300, 80). Priya then moves it to (600, 90). Rudraksh presses Ctrl+Z. Should the box jump back to (100, 50), wiping out Priya's move?

The usual answer is **no**: before applying an inverse, check whether the property's current stamp is still yours. If someone else wrote it since, skip that property.

```ts
// inside undo(), per property of each inverse op
if (shape[prop].stamp.client !== clientId) continue;   // someone else changed it: leave it
```

**Group actions into one undo step.** A drag fires dozens of updates, but the user thinks of it as one move. Record one entry at pointer-up with the start position as the inverse. Same for "paste 20 shapes": one entry.

**Interview point:** "Undo is per-user and implemented as inverse operations re-stamped as new writes, so it propagates through the same LWW path. Properties overwritten by others since are skipped to avoid clobbering their work."

## 10. Camera: pan and zoom maths

Shapes live in world coordinates on an infinite board; each user has a private camera (offset + zoom) that converts world to screen. Only world coordinates are ever synced or saved.

**Two coordinate systems**

- **World:** where a shape really is. `x: 5000` means 5000 units right of the board's origin, for everyone.
- **Screen:** pixels on *your* monitor right now. Depends on how far you've scrolled and zoomed.

The camera is three numbers: `cam.x`, `cam.y` (the world point at your screen's top-left corner) and `cam.zoom` (1 = 100%, 2 = 200%).

```
screen = (world - cam) × zoom          world = screen / zoom + cam
```

```ts
const toScreen = (wx: number, wy: number) => [(wx - cam.x) * cam.zoom, (wy - cam.y) * cam.zoom];
const toWorld  = (sx: number, sy: number) => [sx / cam.zoom + cam.x, sy / cam.zoom + cam.y];
```

**Every mouse event gets converted first.** The browser gives screen pixels; call `toWorld` before creating shapes, hit testing or sending cursors. Forgetting this is the most common whiteboard bug: shapes appear in the wrong place as soon as you zoom.

**Panning** (drag with space or middle mouse): move the camera opposite to the mouse, scaled by zoom.

```ts
cam.x -= dxPixels / cam.zoom;
cam.y -= dyPixels / cam.zoom;
```

**Zooming around the cursor.** If you just multiply `zoom`, the board zooms toward the top-left corner, which feels wrong. Users expect the point under the mouse to stay under the mouse. So:

1. Remember the world point under the cursor *before* zooming.
2. Change the zoom.
3. Move the camera so that same world point is back under the cursor.

```ts
function zoomAt(sx: number, sy: number, factor: number) {
  const [wx, wy] = toWorld(sx, sy);                         // 1
  cam.zoom = Math.min(8, Math.max(0.1, cam.zoom * factor)); // 2 (clamped)
  cam.x = wx - sx / cam.zoom;                               // 3
  cam.y = wy - sy / cam.zoom;
}
// wheel: zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.001))
```

Step 3 is just the `toWorld` formula solved for `cam`. Using `Math.exp` for the factor makes zooming in and out symmetric and smooth on trackpads.

**Drawing with the camera.** Instead of converting every shape by hand, set the canvas transform once per frame and draw shapes in world coordinates:

```ts
ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, -cam.x * cam.zoom * dpr, -cam.y * cam.zoom * dpr);
```

`dpr` is `window.devicePixelRatio` (2 on most phones and Retina screens). Size the canvas at `width × dpr` pixels, or everything looks blurry.

**Line widths.** Shape borders scale with zoom (they're part of the drawing). UI elements such as selection handles should stay the same size on screen: draw them with width `1 / cam.zoom` in world units.

**Interview point:** "Clients keep a private camera transform; everything synced is in world space, and zoom is anchored at the cursor by solving the screen-to-world equation for the new offset."

## 11. Quadtree and hit testing

A quadtree divides the board into squares so you only examine shapes near the screen or the mouse, turning "check all 10,000 shapes" into "check a few dozen." Hit testing then decides exactly which of those shapes the mouse is on.

### 11a. Bounding boxes first

Every shape gets an **axis-aligned bounding box (AABB)**: the smallest upright rectangle containing it. For a rectangle that's itself; for a stroke, the min/max of its points (which are relative, so add the stroke's `x, y`) plus half the line width. Stroke boxes are always computed from the points, never stored. Two boxes overlap unless one is entirely left, right, above or below the other:

```ts
interface Box { minX: number; minY: number; maxX: number; maxY: number }
const overlaps = (a: Box, b: Box) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
```

AABB checks are cheap (4 comparisons), so they're the first filter for everything.

### 11b. The quadtree

**The problem.** Each frame you must find shapes visible on screen; each mouse move, the shape under the cursor. Checking all N shapes is O(N) every time; with 10,000 shapes at 60 fps, that's 600,000 checks a second just for drawing.

**How it's built**

1. Start with one square node covering the whole board, holding a list of shapes.
2. When a node holds more than `MAX` shapes (say 16), split it into **4 children**: top-left, top-right, bottom-left, bottom-right.
3. Move each shape into the child that fully contains its box. A shape that straddles a dividing line stays in the parent.
4. Stop splitting at a maximum depth (say 10) so tiny dense areas don't recurse forever.

Busy regions get finely divided; empty regions stay as one big square.

**How a query works.** To find shapes overlapping a box Q (your screen, or a small box around the mouse):

1. If Q doesn't overlap this node's square, **skip the whole node and everything below it**.
2. Otherwise check this node's own shapes against Q, then recurse into the 4 children.

Step 1 is where the speed comes from: huge empty or off-screen areas are rejected with a single check.

```ts
class QuadNode {
  shapes: { id: string; box: Box }[] = [];
  kids: QuadNode[] | null = null;
  constructor(public bounds: Box, public depth = 0) {}

  insert(item: { id: string; box: Box }) {
    if (this.kids) {
      const k = this.kids.find(c => contains(c.bounds, item.box));
      if (k) return k.insert(item);
    }
    this.shapes.push(item);
    if (!this.kids && this.shapes.length > 16 && this.depth < 10) this.split();
  }

  query(q: Box, out: string[] = []): string[] {
    if (!overlaps(this.bounds, q)) return out;            // prune
    for (const s of this.shapes) if (overlaps(s.box, q)) out.push(s.id);
    this.kids?.forEach(k => k.query(q, out));
    return out;
  }

  private split() {
    const { minX, minY, maxX, maxY } = this.bounds;
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2, d = this.depth + 1;
    this.kids = [
      new QuadNode({ minX, minY, maxX: mx, maxY: my }, d),
      new QuadNode({ minX: mx, minY, maxX, maxY: my }, d),
      new QuadNode({ minX, minY: my, maxX: mx, maxY }, d),
      new QuadNode({ minX: mx, minY: my, maxX, maxY }, d),
    ];
    const old = this.shapes; this.shapes = [];
    old.forEach(s => this.insert(s));
  }
}

const contains = (outer: Box, inner: Box) =>
  inner.minX >= outer.minX && inner.maxX <= outer.maxX &&
  inner.minY >= outer.minY && inner.maxY <= outer.maxY;
```

**Moving and deleting.** Keep a `Map<shapeId, QuadNode>` of where each shape lives. On update: remove it from that node, recompute its box, insert again. On delete: just remove.

**Infinite board.** The root needs fixed bounds. Use a huge square (±1,000,000 units). If a shape ever lands outside, rebuild the tree with a bigger root, which is rare and cheap.

**Cost:** queries are about O(log N + k), where k is the number of results. For a board of 10,000 shapes, a screen query typically touches a few hundred instead of 10,000.

### 11c. Exact hit testing

The quadtree gives **candidates** whose boxes contain the mouse. The exact test depends on the shape:

| Shape | Hit if… |
| --- | --- |
| Rectangle | Point inside the box (filled), or within a few px of an edge (outline only) |
| Ellipse | `((px - cx) / rx)² + ((py - cy) / ry)² ≤ 1` |
| Stroke / arrow | Distance from point to any segment ≤ half line width + tolerance |

Distance from a point to a line **segment** (not the infinite line, as in RDP), clamping to the segment's ends:

```ts
function distToSegment(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));                   // clamp to the segment
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
```

Make the tolerance a fixed number of **screen** pixels (e.g. 6 px ÷ zoom in world units), so thin lines stay clickable when zoomed out.

**Which shape wins when several are hit?** The one with the highest z-key (section 5), i.e. the one drawn on top.

**Box selection** (drag a rectangle to select many) is one quadtree query with the selection box, then keep shapes whose AABB is fully inside it.

**Interview point:** "A region quadtree over shape AABBs gives roughly logarithmic viewport culling and hit testing, with exact geometry tests only on the few candidates."

## 12. Persistence, offline sync and scaling

The server appends every op to a log and periodically saves a snapshot; loading a board means latest snapshot plus the ops after it. Offline clients queue ops and replay them on reconnect, and LWW merges them with no special code. Multiple servers stay in sync through Redis pub/sub. (Exact tables, keys and timings are in `system-design.md`.)

### 12a. Operation log + snapshots

**Operation log.** Every accepted op gets a per-board sequence number from the server (1, 2, 3…) and is appended to Postgres.

Note the two different orderings: Lamport stamps decide **who wins** a conflict; the server's `seq` is just **arrival order** for storage and catch-up.

**Batch the writes.** Don't run one INSERT per op. Buffer ops in memory and flush in one multi-row INSERT. If the server crashes, unflushed ops are lost from the log, but their authors still hold them as pending (section 6) and resend on reconnect, because acks are only sent after commit.

**Snapshots.** Every 500 ops (or 1 minute of activity), serialize the current board state and save it with the `seq` it covers. During the snapshot, garbage-collect old tombstones (section 4).

**Loading a board**

1. Read the newest snapshot (`seq = S`).
2. Read ops with `seq > S`, in order.
3. Apply them to the snapshot.

At most 500 ops are replayed, so load time stays flat however old the board is.

**Version history for free.** To show the board as it was at 3 pm yesterday: take the newest snapshot before that time and replay ops up to 3 pm. To restore it, compute the differences from the current state and submit them as normal updates, so the restore itself is undoable and syncs live.

### 12b. Catch-up and offline sync

Each client remembers `lastSeq`, the highest server sequence it has applied.

**Short disconnect (Wi-Fi blip):** on reconnect, send `hello { boardId, lastSeq }`. The server replies with every op where `seq > lastSeq`. The client applies them, then resends its pending queue.

**Long offline session:** the user keeps drawing; ops pile up in the pending queue, saved to IndexedDB so a closed tab doesn't lose them (stretch goal). On reconnect, the same `hello` + resend happens. Every op carries its Lamport stamp, so LWW merges everything correctly with no special merge logic. This is the payoff of the design.

**Too far behind:** if `lastSeq` is older than the oldest op still in the log (or tombstones it might depend on were already collected), the server sends a fresh snapshot instead, and the client reapplies its pending queue on top. Loading the snapshot also clears the client's buffer of ops waiting for their create (section 3).

### 12c. Rooms and scaling across servers

**Rooms.** The WebSocket server keeps `Map<boardId, Set<socket>>`. An op for a board is broadcast only to that board's sockets, excluding the sender (who already applied it).

**The multi-server problem.** With two servers behind a load balancer, Rudraksh may connect to Server A and Priya to Server B while on the same board. A's local room doesn't include Priya.

**Option 1: Redis pub/sub (what we build).** Each server publishes every accepted op to channel `board:{id}` and subscribes to the channels of boards it has users for. When a message arrives from Redis, it forwards it to its local sockets. To assign `seq` consistently across servers, use Redis `INCR seq:{boardId}`, which is atomic.

**Option 2: one owner server per board (describe in interviews).** Route all users of a board to the same server using **consistent hashing** on the board ID. That server holds the board in memory, assigns `seq` locally, and owns persistence. Fewer moving parts per op and faster, but you need routing logic and a handover when a server dies. When servers are added or removed, consistent hashing moves only about 1/N of the boards instead of reshuffling all of them.

**Memory.** Unload a board from server memory when its last user leaves (after a short delay, in case they refresh), taking a final snapshot first.

**Security.** Authenticate the WebSocket during the upgrade (JWT in a cookie), and check the user's role (owner / editor / viewer) on **every** op, not just at connect, because roles can change while a socket is open.

**Interview point:** "Ops are appended to a per-board log with server sequence numbers and compacted by periodic snapshots. Clients catch up from their last sequence, offline queues merge through the same LWW path, and Redis pub/sub fans out across stateless WebSocket nodes."

## 13. Scope for v1: what to build and what to skip

Build sections 1–11 fully and the simple versions of section 12.

| Feature | v1 decision | Section |
| --- | --- | --- |
| Shapes: rectangle, ellipse, arrow, freehand, sticky note | Build | 1, 7 |
| Lamport clocks + LWW + tombstones | Build (this is the core) | 2–4 |
| Fractional z-index | Build | 5 |
| Optimistic updates, pending queue, acks | Build | 6 |
| Stroke chunk streaming + RDP + smoothing | Build; whole-stroke eraser only | 7 |
| Live cursors, selections, online list | Build | 8 |
| Per-user undo / redo | Build | 9 |
| Pan, zoom-to-cursor, HiDPI canvas | Build | 10 |
| Quadtree culling + hit testing + box select | Build | 11 |
| Op log + snapshots + reload | Build | 12a |
| Reconnect catch-up with `lastSeq` | Build | 12b |
| Offline queue saved in IndexedDB | Stretch goal | 12b |
| Redis pub/sub across 2 servers | Build the simple version; demo with 2 local processes | 12c |
| Version history UI | Skip (describe it) | 12a |
| Consistent-hashing board owners | Skip (describe it) | 12c |
| Partial-stroke eraser | Skip | 7d |
| Text CRDT inside sticky notes | Skip: use LWW on the whole text field | below |
| Images, export to PNG | Skip unless time is left | |

**Text inside sticky notes.** With LWW on the `text` property, if two people type in the same note at the same moment, one person's text replaces the other's. For v1, reduce how often that happens: while someone is editing a note, broadcast it through presence ("Priya is typing") and show the note as locked for others. That's a soft lock, not a guarantee, and it's honest to say so in interviews. A text CRDT for notes is the natural "next step" answer.

**What "done" looks like**

- [ ] Three browser windows on one board, all converging after rapid simultaneous edits
- [ ] A randomized convergence test: N simulated clients apply random ops in random orders and end with identical boards
- [ ] Network-throttled demo (Chrome DevTools "Slow 3G") still feels instant for the local user
- [ ] Kill the server mid-session, restart it, and no work is lost
- [ ] A load test number, e.g. "30 clients on one board, p95 op relay latency under X ms"
- [ ] README with the architecture diagram, the algorithms list and a 60-second demo video

The randomized convergence test is the single most convincing artifact you can show an interviewer: it proves the algorithms work, not just the demo.
