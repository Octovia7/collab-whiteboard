type Listener<T> = (payload: T) => void;

/** Tiny typed event emitter. Stores and the camera use it so React can subscribe to only what it needs. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  /** Returns an unsubscribe function, handy as a React effect cleanup. */
  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners[type];
    if (!set) {
      set = new Set();
      this.listeners[type] = set;
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.listeners[type]?.forEach((fn) => fn(payload));
  }
}
