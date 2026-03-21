import { describe, it, expect } from 'vitest';
import { resolvePins } from './resolve-pin';
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

describe('resolvePins', () => {
  it('returns null for unpinned slots', () => {
    const result = resolvePins([], [null, null]);
    expect(result).toEqual([null, null]);
  });

  it('resolves review card (oldest) for a pinned slot', () => {
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePins(cards, [null, 10]);
    expect(result).toEqual([null, 2]); // oldest review card
  });

  it('falls back to running card (newest updatedAt) when no review cards', () => {
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePins(cards, [null, 10]);
    expect(result).toEqual([null, 2]); // newest running card
  });

  it('prefers review over running', () => {
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePins(cards, [null, 10]);
    expect(result).toEqual([null, 1]); // review takes priority
  });

  it('returns null when no qualifying cards exist', () => {
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'backlog' }),
      makeCard({ id: 2, projectId: 99, column: 'review' }),
    ];
    const result = resolvePins(cards, [null, 10]);
    expect(result).toEqual([null, null]);
  });

  it('distributes cards across multiple slots pinned to same project', () => {
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
      makeCard({ id: 3, projectId: 10, column: 'running', updatedAt: '2026-03-20T03:00:00Z' }),
    ];
    const result = resolvePins(cards, [null, 10, 10]);
    expect(result).toEqual([null, 1, 2]); // oldest review, then next review
  });

  it('handles mixed projects across slots', () => {
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePins(cards, [null, 10, 20]);
    expect(result).toEqual([null, 1, 2]);
  });

  it('excludes cards already open in unpinned slots', () => {
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    // Card 1 is open in the hotseat (slot 0, unpinned)
    const result = resolvePins(cards, [null, 10], [1, null]);
    expect(result).toEqual([null, 2]); // skips card 1, shows card 2
  });

  it('shows empty when all qualifying cards are in unpinned slots', () => {
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePins(cards, [null, 10], [1, null]);
    expect(result).toEqual([null, null]); // only card is in hotseat
  });

  it('ignores cards in other columns (backlog, ready, done, archive)', () => {
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'backlog' }),
      makeCard({ id: 2, projectId: 10, column: 'ready' }),
      makeCard({ id: 3, projectId: 10, column: 'done' }),
      makeCard({ id: 4, projectId: 10, column: 'archive' }),
    ];
    const result = resolvePins(cards, [null, 10]);
    expect(result).toEqual([null, null]);
  });
});
