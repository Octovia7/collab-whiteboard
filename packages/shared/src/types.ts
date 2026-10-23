/** `clientId-counter`, generated on the client (see ids.ts). Never assigned by the server. */
export type ShapeId = string;

/** Lamport timestamp. `client` is the tab's random clientId and breaks ties between equal `t`. */
export interface Stamp {
  t: number;
  client: string;
}

/** `note` is the sticky note; its content is the `text` property. */
export type ShapeType = 'rect' | 'ellipse' | 'arrow' | 'stroke' | 'note';

export interface Shape {
  id: ShapeId;
  type: ShapeType;
  /** World coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  /** Fractional index (fractional.ts). Draw order is (z, id). */
  z: string;
  /**
   * Strokes only: final simplified list [x1, y1, x2, y2, ...]. Written only by the pen-up
   * update, never by the create: while unset, the stroke is drawn from its streamed chunks.
   */
  points?: number[];
  text?: string;
  /** Tombstone flag. A normal LWW property, so undo can write it back to false. */
  deleted?: boolean;
}

/** Everything on a shape that is an LWW register. `id` is the map key, never a register. */
export type ShapeProps = Omit<Shape, 'id'>;
export type PropKey = keyof ShapeProps;

export interface CreateOp {
  kind: 'create';
  opId: string;
  stamp: Stamp;
  shape: Shape;
}

/** Delete is `update { deleted: true }`. */
export interface UpdateOp {
  kind: 'update';
  opId: string;
  stamp: Stamp;
  id: ShapeId;
  props: Partial<ShapeProps>;
}

/** Streams stroke points while drawing. `chunk` is the author's per-stroke chunk number (0, 1, 2...). */
export interface AppendOp {
  kind: 'append';
  opId: string;
  stamp: Stamp;
  id: ShapeId;
  chunk: number;
  points: number[];
}

export type Op = CreateOp | UpdateOp | AppendOp;

/** Last-Writer-Wins register: a value plus the stamp of whoever wrote it. */
export interface Reg<T> {
  value: T;
  stamp: Stamp;
}
