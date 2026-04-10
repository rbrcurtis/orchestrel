import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../ring-buffer';

describe('RingBuffer', () => {
  it('stores and retrieves events in order', () => {
    const buf = new RingBuffer<string>(5);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.since(-1)).toEqual([
      { index: 0, item: 'a' },
      { index: 1, item: 'b' },
      { index: 2, item: 'c' },
    ]);
  });

  it('wraps around when capacity exceeded', () => {
    const buf = new RingBuffer<string>(3);
    buf.push('a'); // 0
    buf.push('b'); // 1
    buf.push('c'); // 2
    buf.push('d'); // 3  — evicts 'a'
    buf.push('e'); // 4  — evicts 'b'
    const items = buf.since(-1);
    expect(items).toEqual([
      { index: 2, item: 'c' },
      { index: 3, item: 'd' },
      { index: 4, item: 'e' },
    ]);
  });

  it('returns events after a given index', () => {
    const buf = new RingBuffer<string>(10);
    buf.push('a'); // 0
    buf.push('b'); // 1
    buf.push('c'); // 2
    buf.push('d'); // 3
    expect(buf.since(1)).toEqual([
      { index: 2, item: 'c' },
      { index: 3, item: 'd' },
    ]);
  });

  it('returns empty array when afterIndex >= lastIndex', () => {
    const buf = new RingBuffer<string>(5);
    buf.push('a'); // 0
    buf.push('b'); // 1
    expect(buf.since(1)).toEqual([]);
    expect(buf.since(5)).toEqual([]);
  });

  it('returns lastIndex correctly', () => {
    const buf = new RingBuffer<string>(5);
    expect(buf.lastIndex).toBe(-1);
    buf.push('a');
    expect(buf.lastIndex).toBe(0);
    buf.push('b');
    expect(buf.lastIndex).toBe(1);
  });

  it('handles since() when requested index was already evicted', () => {
    const buf = new RingBuffer<string>(2);
    buf.push('a'); // 0
    buf.push('b'); // 1
    buf.push('c'); // 2 — evicts 'a'
    // Requesting after index 0, but 'a' (index 0) is gone.
    // Should return everything still in the buffer.
    const items = buf.since(0);
    expect(items).toEqual([
      { index: 1, item: 'b' },
      { index: 2, item: 'c' },
    ]);
  });
});
