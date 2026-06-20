import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readConversation, writeConversation, __setBudgetForTest } from './conversation-cache';

const store = new Map<string, unknown>();
const get = vi.fn((k: string) => Promise.resolve(store.get(k)));
const set = vi.fn((k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); });
const del = vi.fn((k: string) => { store.delete(k); return Promise.resolve(); });

vi.mock('idb-keyval', () => ({
  get: (...a: unknown[]) => get(a[0] as string),
  set: (...a: unknown[]) => set(a[0] as string, a[1]),
  del: (...a: unknown[]) => del(a[0] as string),
}));

describe('conversation-cache', () => {
  beforeEach(() => {
    store.clear();
    get.mockClear();
    set.mockClear();
    del.mockClear();
    __setBudgetForTest(1000); // 1000-byte budget for testing
  });

  it('round-trips a conversation by cardId', async () => {
    await writeConversation(1, [{ kind: 'user', content: 'hi' }]);
    const out = await readConversation(1);
    expect(out).toEqual([{ kind: 'user', content: 'hi' }]);
  });

  it('returns null for a missing card', async () => {
    expect(await readConversation(99)).toBeNull();
  });

  it('evicts the oldest card when over budget, keeping the active card', async () => {
    const big = (n: number) => [{ kind: 'user', content: 'x'.repeat(n) }];
    await writeConversation(1, big(600)); // card 1 oldest
    await writeConversation(2, big(600)); // total now > 1000 → card 1 evicted
    expect(await readConversation(1)).toBeNull();
    expect(await readConversation(2)).not.toBeNull();
  });

  it('keeps the active card even if it alone exceeds budget', async () => {
    await writeConversation(1, [{ kind: 'user', content: 'x'.repeat(5000) }]);
    expect(await readConversation(1)).not.toBeNull();
  });
});
