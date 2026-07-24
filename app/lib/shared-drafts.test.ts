import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { clear, createStore } from 'idb-keyval';
import { importSharedDrafts, listDrafts, type SharedDraftNative } from './shared-drafts';

const store = createStore('shared-drafts-test', 'drafts');
afterEach(() => clear(store));

function native(overrides: Partial<SharedDraftNative> = {}): SharedDraftNative {
  return {
    list: async () => ({ drafts: [{ id: 'share-1', createdAt: '2026-07-24T00:00:00Z' }] }),
    read: async () => ({
      version: 1,
      id: 'share-1',
      createdAt: '2026-07-24T00:00:00Z',
      text: 'https://example.com',
      files: [],
      errors: [],
    }),
    acknowledge: async () => {},
    discard: async () => {},
    ...overrides,
  };
}

describe('shared draft import', () => {
  it('acknowledges only after the draft is durable', async () => {
    const order: string[] = [];
    const api = native({
      acknowledge: async () => {
        expect((await listDrafts('card', store)).map((draft) => draft.id)).toEqual(['share-1']);
        order.push('ack');
      },
    });

    await importSharedDrafts('card', { native: api, store });

    expect(order).toEqual(['ack']);
  });

  it('imports duplicate manifest ids only once', async () => {
    const api = native();
    await importSharedDrafts('card', { native: api, store });
    await importSharedDrafts('card', { native: api, store });

    expect(await listDrafts('card', store)).toHaveLength(1);
  });

  it('preserves existing drafts and queues incoming shares separately', async () => {
    await importSharedDrafts('card', { native: native(), store });
    await importSharedDrafts('card', {
      native: native({
        list: async () => ({ drafts: [{ id: 'share-2', createdAt: '2026-07-24T01:00:00Z' }] }),
        read: async () => ({ version: 1, id: 'share-2', createdAt: '2026-07-24T01:00:00Z', text: 'second', files: [], errors: [] }),
      }),
      store,
    });

    expect((await listDrafts('card', store)).map((draft) => draft.text)).toEqual(['https://example.com', 'second']);
  });
});
