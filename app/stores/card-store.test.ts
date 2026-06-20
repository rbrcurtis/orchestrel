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

type MockEmit = ReturnType<typeof vi.fn> & ((event: 'card:suggestTitle' | 'card:create', data: SuggestPayload | CreatePayload) => Promise<unknown>);

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
    sourceBranch: null,
    model: 'sonnet',
    provider: 'anthropic',
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

    const card = await store.createChatCard({ description: 'Build a new component', projectId: 12, summarizeThreshold: 0.6 });

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

  it('falls back to New chat when suggested title is empty', async () => {
    const emit: MockEmit = vi
      .fn()
      .mockResolvedValueOnce('   ')
      .mockResolvedValueOnce(makeCard({ title: 'New chat' }));

    const store = new CardStore();
    store.setWs({ emit } as unknown as WsClient);

    await store.createChatCard({ description: 'What is this issue?', projectId: 12, model: 'sonnet', thinkingLevel: 'high' });

    expect(emit).toHaveBeenCalledWith('card:create', expect.objectContaining({ title: 'New chat', projectId: 12 }));
    expect(emit.mock.calls[1]).toEqual([
      'card:create',
      expect.objectContaining({ description: 'What is this issue?' }),
    ]);
  });

  it('falls back to New chat when suggestTitle fails', async () => {
    const emit: MockEmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('suggestion failed'))
      .mockResolvedValueOnce(makeCard({ title: 'New chat' }));

    const store = new CardStore();
    store.setWs({ emit } as unknown as WsClient);

    await store.createChatCard({ description: 'Need idea', projectId: 12, summarizeThreshold: 0.8 });

    expect(emit).toHaveBeenCalledWith('card:create', expect.objectContaining({
      title: 'New chat',
      description: 'Need idea',
      projectId: 12,
      summarizeThreshold: 0.8,
      archiveOthers: true,
      model: undefined,
      thinkingLevel: undefined,
    }));
    expect(store.cards.get(501)?.title).toBe('New chat');
  });
});
