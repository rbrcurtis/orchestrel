import { describe, it, expect } from 'vitest';
import { resolvePinnedCards } from './resolve-pin';
import type { SlotState } from './resolve-pin';
import type { Card } from '../../src/shared/ws-protocol';

function makeCard(overrides: Partial<Card> & { id: number }): Card {
  return {
    title: `Card ${overrides.id}`,
    description: '',
    column: 'backlog',
    position: 0,
    projectId: null,
    prUrl: null,
    sessionId: null,
    worktreePath: null,
    worktreeBranch: null,
    useWorktree: true,
    sourceBranch: null,
    model: 'sonnet',
    thinkingLevel: 'high',
    promptsSent: 0,
    turnsCompleted: 0,
    contextTokens: 0,
    contextWindow: 200000,
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    queuePosition: null,
    ...overrides,
  };
}

describe('resolvePinnedCards', () => {
  it('returns empty map when no pinned slots', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'empty' }];
    expect(resolvePinnedCards(slots, []).size).toBe(0);
  });

  it('returns empty map when pinned slot has no eligible cards', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'backlog' }),
      makeCard({ id: 2, projectId: 10, column: 'done' }),
    ];
    expect(resolvePinnedCards(slots, cards).size).toBe(0);
  });

  it('resolves oldest review card for a pinned slot', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(2);
  });

  it('resolves active running card when no review cards', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', queuePosition: null, updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', queuePosition: null, updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(2);
  });

  it('prefers review over running', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', queuePosition: null, updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    expect(resolvePinnedCards(slots, cards).get(1)).toBe(1);
  });

  it('ranks active running (queuePosition null) above queued running', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', queuePosition: 1, updatedAt: '2026-03-20T03:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', queuePosition: null, updatedAt: '2026-03-20T01:00:00Z' }),
    ];
    expect(resolvePinnedCards(slots, cards).get(1)).toBe(2);
  });

  it('ranks queued running cards by queuePosition ascending', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', queuePosition: 2 }),
      makeCard({ id: 2, projectId: 10, column: 'running', queuePosition: 1 }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(2);
    expect(result.get(2)).toBe(1);
  });

  it('uses updatedAt as tiebreak within active running group', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', queuePosition: null, updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', queuePosition: null, updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(2);
    expect(result.get(2)).toBe(1);
  });

  it('distributes ranked cards across multiple slots for same project', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1);
    expect(result.get(2)).toBe(2);
  });

  it('handles multiple projects independently', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 20 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1);
    expect(result.get(2)).toBe(2);
  });

  it('excludes cards in manual slots from resolution', () => {
    const slots: SlotState[] = [
      { type: 'manual', cardId: 1 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(2);
  });

  it('excludes pinned override cards from resolution', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10, cardId: 3 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
      makeCard({ id: 3, projectId: 10, column: 'done' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1);
    expect(result.get(2)).toBe(2);
  });

  it('returns absent entry (not null) for pinned slot with no qualifying card', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10, cardId: 3 }];
    const cards = [makeCard({ id: 3, projectId: 10, column: 'done' })];
    const result = resolvePinnedCards(slots, cards);
    expect(result.has(1)).toBe(false);
  });

  it('ignores cards with null projectId', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [makeCard({ id: 1, projectId: null, column: 'review', createdAt: '2026-03-20T01:00:00Z' })];
    expect(resolvePinnedCards(slots, cards).size).toBe(0);
  });

  it('ignores cards belonging to non-pinned projects', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [makeCard({ id: 1, projectId: 99, column: 'review', createdAt: '2026-03-20T01:00:00Z' })];
    expect(resolvePinnedCards(slots, cards).size).toBe(0);
  });

  it('distributes three queued running cards by queuePosition across three pinned slots', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', queuePosition: 3 }),
      makeCard({ id: 2, projectId: 10, column: 'running', queuePosition: 1 }),
      makeCard({ id: 3, projectId: 10, column: 'running', queuePosition: 2 }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(2);
    expect(result.get(2)).toBe(3);
    expect(result.get(3)).toBe(1);
  });

  it('returns empty map when all eligible cards are manually placed', () => {
    const slots: SlotState[] = [
      { type: 'manual', cardId: 1 },
      { type: 'manual', cardId: 2 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    expect(resolvePinnedCards(slots, cards).size).toBe(0);
  });

  it('uses independent exclusion sets per project', () => {
    const slots: SlotState[] = [
      { type: 'manual', cardId: 1 },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 20 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
      makeCard({ id: 3, projectId: 20, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(2);
    expect(result.get(2)).toBe(3);
  });
});
