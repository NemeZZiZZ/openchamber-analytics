/**
 * Deduplicated priority queue for message-history sync work.
 *
 * Lower priority numbers run first; within one priority the larger sortKey
 * (newer session activity) runs first. Re-pushing an existing id updates its
 * priority instead of duplicating the work item.
 */
export type PriorityQueue = {
  push(sessionId: string, priority: number, sortKey: number): void;
  setPriority(sessionId: string, priority: number): void;
  pop(): string | null;
  remove(sessionId: string): void;
  has(sessionId: string): boolean;
  size(): number;
  clear(): void;
};

type Entry = { sessionId: string; priority: number; sortKey: number; version: number };

export function createPriorityQueue(): PriorityQueue {
  // `entries` is the source of truth; `heap` may hold stale nodes (older
  // versions of a re-prioritised or removed id) that pop() discards lazily.
  const entries = new Map<string, Entry>();
  const heap: Entry[] = [];
  let versionCounter = 0;

  const before = (a: Entry, b: Entry): boolean =>
    a.priority !== b.priority
      ? a.priority < b.priority
      : a.sortKey !== b.sortKey
        ? a.sortKey > b.sortKey
        : a.sessionId < b.sessionId;

  const swap = (a: number, b: number): void => {
    const first = heap[a] as Entry;
    heap[a] = heap[b] as Entry;
    heap[b] = first;
  };

  const lessAt = (a: number, b: number): boolean => before(heap[a] as Entry, heap[b] as Entry);

  const siftUp = (from: number): void => {
    let index = from;

    while (index > 0) {
      const parent = (index - 1) >> 1;

      if (!lessAt(index, parent)) break;

      swap(index, parent);
      index = parent;
    }
  };

  const siftDown = (from: number): void => {
    let index = from;

    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;

      if (left < heap.length && lessAt(left, best)) best = left;
      if (right < heap.length && lessAt(right, best)) best = right;
      if (best === index) return;

      swap(index, best);
      index = best;
    }
  };

  const insert = (sessionId: string, priority: number, sortKey: number): void => {
    const entry: Entry = { sessionId, priority, sortKey, version: ++versionCounter };
    entries.set(sessionId, entry);
    heap.push(entry);
    siftUp(heap.length - 1);
  };

  const popHeap = (): Entry | undefined => {
    const top = heap[0];
    const last = heap.pop();

    if (heap.length > 0 && last) {
      heap[0] = last;
      siftDown(0);
    }

    return top;
  };

  return {
    push(sessionId, priority, sortKey) {
      insert(sessionId, priority, sortKey);
    },

    setPriority(sessionId, priority) {
      const existing = entries.get(sessionId);

      if (existing && existing.priority !== priority) {
        insert(sessionId, priority, existing.sortKey);
      }
    },

    pop(): string | null {
      for (;;) {
        const top = popHeap();

        if (!top) {
          return null;
        }

        if (entries.get(top.sessionId) === top) {
          entries.delete(top.sessionId);
          return top.sessionId;
        }
      }
    },

    remove(sessionId) {
      entries.delete(sessionId);
    },

    has(sessionId) {
      return entries.has(sessionId);
    },

    size() {
      return entries.size;
    },

    clear() {
      entries.clear();
      heap.length = 0;
    },
  };
}
