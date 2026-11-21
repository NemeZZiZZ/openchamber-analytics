import { describe, expect, it } from 'vitest';

import { createPriorityQueue } from '../../src/service/sync-queue';

describe('createPriorityQueue', () => {
  it('pops by priority, then newest sort key, then id', () => {
    const queue = createPriorityQueue();
    queue.push('b', 1, 10);
    queue.push('a', 1, 10);
    queue.push('c', 1, 50);
    queue.push('z', 0, 1);

    expect([queue.pop(), queue.pop(), queue.pop(), queue.pop(), queue.pop()]).toEqual(['z', 'c', 'a', 'b', null]);
  });

  it('deduplicates re-pushed ids and honours the latest priority', () => {
    const queue = createPriorityQueue();
    queue.push('a', 2, 1);
    queue.push('b', 1, 1);
    queue.push('a', 0, 1);

    expect(queue.size()).toBe(2);
    expect(queue.pop()).toBe('a');
    expect(queue.pop()).toBe('b');
    expect(queue.pop()).toBeNull();
  });

  it('reprioritises and removes without leaving stale work behind', () => {
    const queue = createPriorityQueue();
    queue.push('a', 1, 1);
    queue.push('b', 1, 2);
    queue.push('c', 1, 3);

    queue.setPriority('a', 0);
    queue.remove('c');

    expect(queue.has('c')).toBe(false);
    expect(queue.pop()).toBe('a');
    expect(queue.pop()).toBe('b');
    expect(queue.pop()).toBeNull();
    expect(queue.size()).toBe(0);
  });

  it('drains many items in order', () => {
    const queue = createPriorityQueue();
    for (let i = 0; i < 2000; i++) queue.push(`s${i}`, i % 3, i);
    let previous: [number, number] | null = null;
    let count = 0;
    for (let id = queue.pop(); id !== null; id = queue.pop()) {
      const n = Number(id.slice(1));
      const key: [number, number] = [n % 3, -n];
      if (previous) expect(previous[0] < key[0] || (previous[0] === key[0] && previous[1] <= key[1])).toBe(true);
      previous = key;
      count++;
    }
    expect(count).toBe(2000);
  });
});
