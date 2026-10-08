import { describe, expect, it, vi } from 'vitest';
import { CardStore } from './card-store';
import type { Card } from '../../src/shared/ws-protocol';
import type { WsClient } from '../lib/ws-client';

type CreatePayload = {
  description: string;
  title: string;
  column: string;
  projectId: number;
  model: string | undefined;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high' | undefined;
  summarizeThreshold?: number;
  archiveOthers: boolean;
};

type SuggestPayload = { description: string };

type MockEmit = ReturnType<typeof vi.fn> &
  ((event: 'card:suggestTitle' | 'card:create', data: SuggestPayload | CreatePayload) => Promise<unknown>);

function makeCard(overrides?: Partial<Card>): Card {
  return {
    id: 501,
    title: 'New chat',
    description: 'Initial prompt text',
    column: 'running',
    position: 0,
    projectId: 12,
    prUrl: null,
    sessionId: null,
    worktreeBranch: null,
    sandbox: false,
    priority: false,
    sourceBranch: null,
    model: 'sonnet',
    provider: 'anthropic',
    nodeName: 'local',
    thinkingLevel: 'high',
    summarizeThreshold: 0.6,
    promptsSent: 0,
    turnsCompleted: 0,
    contextTokens: 0,
    contextWindow: 200000,
    createdAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('CardStore.createChatCard', () => {
  it('uses suggested title for initial chat card creation', async () => {
    const emit: MockEmit = vi
      .fn()
      .mockResolvedValueOnce('Quick fix flaky test')
      .mockResolvedValueOnce(makeCard({ title: 'Quick fix flaky test', description: 'Build a new component' }));

    const store = new CardStore();
    store.setWs({ emit } as unknown as WsClient);

    const card = await store.createChatCard({
      description: 'Build a new component',
      projectId: 12,
      summarizeThreshold: 0.6,
    });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, 'card:suggestTitle', { description: 'Build a new component' });
    expect(emit).toHaveBeenNthCalledWith(2, 'card:create', {
      title: 'Quick fix flaky test',
      description: 'Build a new component',
      column: 'running',
      projectId: 12,
      summarizeThreshold: 0.6,
      archiveOthers: true,
      model: undefined,
      thinkingLevel: undefined,
    });
    expect(card.title).toBe('Quick fix flaky test');
  });

  it('falls back to New Card when suggested title is empty', async () => {
    const emit: MockEmit = vi
      .fn()
      .mockResolvedValueOnce('   ')
      .mockResolvedValueOnce(makeCard({ title: 'New Card' }));

    const store = new CardStore();
    store.setWs({ emit } as unknown as WsClient);

    await store.createChatCard({
      description: 'What is this issue?',
      projectId: 12,
      model: 'sonnet',
      thinkingLevel: 'high',
    });

    expect(emit).toHaveBeenCalledWith('card:create', expect.objectContaining({ title: 'New Card', projectId: 12 }));
    expect(emit.mock.calls[1]).toEqual([
      'card:create',
      expect.objectContaining({ description: 'What is this issue?' }),
    ]);
  });

  it('falls back to New Card when suggestTitle fails', async () => {
    const emit: MockEmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('suggestion failed'))
      .mockResolvedValueOnce(makeCard({ title: 'New Card' }));

    const store = new CardStore();
    store.setWs({ emit } as unknown as WsClient);

    await store.createChatCard({ description: 'Need idea', projectId: 12, summarizeThreshold: 0.8 });

    expect(emit).toHaveBeenCalledWith(
      'card:create',
      expect.objectContaining({
        title: 'New Card',
        description: 'Need idea',
        projectId: 12,
        summarizeThreshold: 0.8,
        archiveOthers: true,
        model: undefined,
        thinkingLevel: undefined,
      }),
    );
    expect(store.cards.get(501)?.title).toBe('New Card');
  });
});

describe('CardStore.cardsByColumn', () => {
  function seededRunning(): CardStore {
    const store = new CardStore();
    store.cards.set(1, makeCard({ id: 1, column: 'running', position: 0 }));
    store.cards.set(2, makeCard({ id: 2, column: 'running', position: 1, priority: true }));
    return store;
  }

  it('orders running by position ASC with starred cards pinned to the front', () => {
    const store = seededRunning();
    store.cards.set(3, makeCard({ id: 3, column: 'running', position: 2 }));
    store.cards.set(4, makeCard({ id: 4, column: 'running', position: 3, priority: true }));
    expect(store.cardsByColumn('running').map((c) => c.id)).toEqual([2, 4, 1, 3]);
  });

  it('orders other sections by updatedAt ASC with starred cards pinned to the front', () => {
    const store = new CardStore();
    store.cards.set(1, makeCard({ id: 1, column: 'review', updatedAt: '2026-05-07T01:00:00Z' }));
    store.cards.set(2, makeCard({ id: 2, column: 'review', priority: true, updatedAt: '2026-05-07T03:00:00Z' }));
    store.cards.set(3, makeCard({ id: 3, column: 'review', updatedAt: '2026-05-07T02:00:00Z' }));
    store.cards.set(4, makeCard({ id: 4, column: 'review', priority: true, updatedAt: '2026-05-07T00:00:00Z' }));
    expect(store.cardsByColumn('review').map((c) => c.id)).toEqual([4, 2, 1, 3]);
  });

  it('orders archive by updatedAt DESC, ignoring stars', () => {
    const store = new CardStore();
    store.cards.set(1, makeCard({ id: 1, column: 'archive', updatedAt: '2026-05-07T02:00:00Z' }));
    store.cards.set(2, makeCard({ id: 2, column: 'archive', priority: true, updatedAt: '2026-05-07T01:00:00Z' }));
    store.cards.set(3, makeCard({ id: 3, column: 'archive', updatedAt: '2026-05-07T03:00:00Z' }));
    expect(store.cardsByColumn('archive').map((c) => c.id)).toEqual([3, 1, 2]);
  });
});
