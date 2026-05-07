import { observable } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persistStore } from './store-persist';

const get = vi.fn();
const set = vi.fn();

vi.mock('idb-keyval', () => ({
  get: (...args: unknown[]) => get(...args),
  set: (...args: unknown[]) => set(...args),
}));

function makeStore(initial: Array<{ id: number; archived: boolean }>) {
  const items = observable.box(initial);

  return {
    serialize() {
      return items.get();
    },
    hydrate(data: unknown[]) {
      items.set(data as Array<{ id: number; archived: boolean }>);
    },
  };
}

describe('persistStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    get.mockReset();
    set.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('hydrates cached data when the store is empty', async () => {
    get.mockResolvedValue([{ id: 1, archived: false }]);
    const store = makeStore([]);

    persistStore(store, 'orchestrel:projects');
    await Promise.resolve();
    await Promise.resolve();

    expect(store.serialize()).toEqual([{ id: 1, archived: false }]);
  });

  it('does not let stale cached data overwrite fresher state', async () => {
    get.mockResolvedValue([{ id: 1, archived: false }]);
    const store = makeStore([{ id: 1, archived: true }]);

    persistStore(store, 'orchestrel:projects');
    await Promise.resolve();
    await Promise.resolve();

    expect(store.serialize()).toEqual([{ id: 1, archived: true }]);
  });
});
