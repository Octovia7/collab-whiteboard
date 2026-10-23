import type { OpStore } from '../persistence/OpStore';
import { Room } from './Room';

/**
 * boardId -> Room. Milestone 4 keeps rooms in memory for the life of the process, because
 * without persistence an unloaded board would be lost. Milestone 5 loads rooms from the latest
 * snapshot + ops and unloads them 60 s after the last socket leaves.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly store: OpStore) {}

  get(boardId: string): Room {
    let room = this.rooms.get(boardId);
    if (!room) {
      room = new Room(boardId, this.store);
      this.rooms.set(boardId, room);
    }
    return room;
  }

  get size(): number {
    return this.rooms.size;
  }
}
