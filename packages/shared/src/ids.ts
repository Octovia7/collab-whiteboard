import type { ShapeId } from './types';

/**
 * Shape IDs are `clientId-counter`: unique across clients because clientIds differ,
 * unique within a client because the counter only goes up. No server round trip,
 * so shapes can be created instantly and offline.
 */
export function createIdGenerator(clientId: string): () => ShapeId {
  let counter = 0;
  return () => `${clientId}-${++counter}`;
}
