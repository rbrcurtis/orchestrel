export interface IndexedItem<T> {
  index: number;
  item: T;
}

/**
 * Fixed-capacity circular buffer with monotonic indexing.
 * Oldest items are evicted when capacity is exceeded.
 */
export class RingBuffer<T> {
  private items: Array<T | undefined>;
  private head = 0;     // write position in items[]
  private count = 0;    // total items currently stored
  private nextIndex = 0; // monotonic event index

  constructor(private capacity: number) {
    this.items = new Array(capacity);
  }

  push(item: T): number {
    const idx = this.nextIndex++;
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return idx;
  }

  get lastIndex(): number {
    return this.nextIndex - 1;
  }

  /**
   * Return all items with index > afterIndex.
   * If afterIndex is -1, returns everything in the buffer.
   */
  since(afterIndex: number): IndexedItem<T>[] {
    if (this.count === 0) return [];

    const oldestIndex = this.nextIndex - this.count;
    const startIndex = Math.max(afterIndex + 1, oldestIndex);

    if (startIndex >= this.nextIndex) return [];

    const result: IndexedItem<T>[] = [];
    for (let idx = startIndex; idx < this.nextIndex; idx++) {
      const pos = ((this.head - this.count + (idx - oldestIndex)) % this.capacity + this.capacity) % this.capacity;
      result.push({ index: idx, item: this.items[pos]! });
    }
    return result;
  }
}
