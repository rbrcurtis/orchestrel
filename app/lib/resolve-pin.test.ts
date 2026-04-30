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
    worktreeBranch: null,
    sourceBranch: null,
    model: 'sonnet',
    provider: 'anthropic',
    thinkingLevel: 'high',
    summarizeThreshold: 0.6,
    promptsSent: 0,
    turnsCompleted: 0,
    contextTokens: 0,
    contextWindow: 200000,
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
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

  it('resolves oldest-updated review card for a pinned slot', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T02:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(2); // oldest updatedAt first
  });

  it('resolves oldest-updated running card when no review cards', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1); // oldest updatedAt first
  });

  it('prefers review over running', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    expect(resolvePinnedCards(slots, cards).get(1)).toBe(1);
  });

  it('distributes running cards oldest-first across multiple slots', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1); // oldest first
    expect(result.get(2)).toBe(2);
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

  it('ignores cards belonging to non-pinned projects in per-project resolution', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [makeCard({ id: 1, projectId: 99, column: 'review', createdAt: '2026-03-20T01:00:00Z' })];
    const result = resolvePinnedCards(slots, cards);
    expect(result.has(1)).toBe(false); // project-10 pin does not pick up project-99 card
    expect(result.get(0)).toBe(1); // hotseat picks it up instead
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

  // ─── Sticky behavior ────────────────────────────────────────────────────────

  it('keeps a currently-displayed review card in its slot when a new review card enters', () => {
    // Slot 1 was showing card 2 (review). Card 1 (older review) enters the pool.
    // Without sticky: card 1 takes slot 1 (oldest), card 2 moves to slot 2.
    // With sticky: card 2 stays in slot 1, card 1 goes to slot 2.
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[1, 2]]); // slot 1 was showing card 2
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(1)).toBe(2); // sticky — stays
    expect(result.get(2)).toBe(1); // new card fills remaining slot
  });

  it('unsticks a card when it leaves review/running', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
    ];
    // Card 2 moved to done — no longer eligible
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'done' }),
    ];
    const prev = new Map([[1, 2]]); // slot 1 was showing card 2
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(1)).toBe(1); // card 2 gone, card 1 fills slot 1
    expect(result.has(2)).toBe(false); // no second card
  });

  it('unsticks a card that was moved to the exclusion set (manual slot)', () => {
    const slots: SlotState[] = [
      { type: 'manual', cardId: 2 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[1, 2]]); // slot 1 was showing card 2
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(1)).toBe(1); // card 2 excluded (manual), card 1 fills
  });

  it('sticks multiple cards across multiple slots for same project', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
      makeCard({ id: 3, projectId: 10, column: 'review', createdAt: '2026-03-20T03:00:00Z' }),
    ];
    // Slots 1 and 2 were showing cards 3 and 1 respectively (reversed from rank order)
    const prev = new Map([
      [1, 3],
      [2, 1],
    ]);
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(1)).toBe(3); // sticky
    expect(result.get(2)).toBe(1); // sticky
    expect(result.get(3)).toBe(2); // remaining card fills remaining slot
  });

  it('keeps a running card sticky even when review cards are waiting', () => {
    // Strict sticky: running card stays in its slot, review card fills empty slots only.
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[1, 2]]); // slot 1 was showing card 2 (running)
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(1)).toBe(2); // strict sticky — stays
  });

  it('keeps a running card sticky when no review cards are waiting', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 2, projectId: 10, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[1, 2]]);
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(1)).toBe(2); // stays — no review cards to replace it
  });

  it('works with no previous results (fresh start)', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' })];
    // No previous — should fall back to ranked distribution
    const result = resolvePinnedCards(slots, cards, new Map());
    expect(result.get(1)).toBe(1);
  });

  it('ignores previous results for slots that are no longer pinned to the same project', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 20 }, // was pinned to 10, now 20
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const prev = new Map([[1, 1]]); // slot 1 was showing card 1 (project 10)
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(1)).toBe(2); // card 1 is for project 10, slot is now project 20
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

  // ─── "all" pin resolution ──────────────────────────────────────────────────

  it('resolves cards from any project into an "all" pinned slot', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1); // oldest review first
  });

  it('distributes all-project cards across multiple "all" slots', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1);
    expect(result.get(2)).toBe(2);
  });

  it('excludes cards already claimed by per-project pins from "all" slots', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1); // project-specific pin takes card 1
    expect(result.get(2)).toBe(2); // "all" gets remaining card 2
  });

  it('excludes cards in manual slots from "all" resolution', () => {
    const slots: SlotState[] = [
      { type: 'manual', cardId: 1 },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(2); // card 1 excluded (manual), card 2 fills
  });

  it('uses same priority ranking in "all" slots: review > running', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 2, projectId: 20, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
      makeCard({ id: 3, projectId: 30, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(3); // review first
    expect(result.get(2)).toBe(2); // running second
  });

  it('sticky behavior works for "all" slots', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[1, 2]]); // slot 1 was showing card 2
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(1)).toBe(2); // sticky
    expect(result.get(2)).toBe(1); // remaining card
  });

  it('keeps running card sticky in "all" slot even when review cards are available', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[1, 2]]); // slot 1 was showing running card 2
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(1)).toBe(2); // strict sticky — stays
  });

  it('returns empty for "all" slot when no eligible cards exist', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'backlog' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.has(1)).toBe(false);
  });

  it('"all" pin respects projectFilter', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    // Filter to project 20 only — the "all" slot should skip project 10 card
    const result = resolvePinnedCards(slots, cards, new Map(), new Set([20]));
    expect(result.get(1)).toBe(2);
  });

  it('"all" pin shows all projects when projectFilter is empty', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards, new Map(), new Set());
    expect(result.get(1)).toBe(1); // empty filter = all projects, oldest first
  });

  it('"all" pin releases sticky card when its project leaves the filter', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[1, 1]]); // slot 1 was showing card 1 (project 10)
    // Filter to project 20 — card 1 is no longer eligible, card 2 should take over
    const result = resolvePinnedCards(slots, cards, prev, new Set([20]));
    expect(result.get(1)).toBe(2);
  });

  it('"all" pin keeps sticky card when its project remains in the filter', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[1, 2]]); // slot 1 was showing card 2 (project 20)
    const result = resolvePinnedCards(slots, cards, prev, new Set([20]));
    expect(result.get(1)).toBe(2); // sticky — stays because still in filter
  });

  // ─── Hotseat virtual pin (slot 0) ──────────────────────────────────────────

  it('resolves a review card into empty slot 0 as virtual hotseat', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(0)).toBe(1);
  });

  it('resolves a running card into empty slot 0 when no review cards', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', updatedAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(0)).toBe(1);
  });

  it('hotseat prefers review over running', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(0)).toBe(2);
  });

  it('hotseat does not fill slot 0 when it is manual', () => {
    const slots: SlotState[] = [{ type: 'manual', cardId: 99 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.has(0)).toBe(false);
  });

  it('hotseat does not fill slot 0 when it is pinned', () => {
    const slots: SlotState[] = [{ type: 'pinned', projectId: 10 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    // Should be resolved by the per-project pass, not the hotseat pass
    expect(result.get(0)).toBe(1);
  });

  it('hotseat excludes cards claimed by per-project pins', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1); // per-project pin gets it
    expect(result.has(0)).toBe(false); // hotseat gets nothing
  });

  it('hotseat excludes cards claimed by "all" pins', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1); // "all" pin gets it
    expect(result.has(0)).toBe(false); // hotseat gets nothing
  });

  it('hotseat gets leftover cards after real pins', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(1); // per-project pin
    expect(result.get(0)).toBe(2); // hotseat gets the leftover
  });

  it('hotseat respects projectFilter', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards, new Map(), new Set([20]));
    expect(result.get(0)).toBe(2); // only project 20 is in the filter
  });

  it('hotseat shows all projects when projectFilter is empty', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards, new Map(), new Set());
    expect(result.get(0)).toBe(1); // empty filter = all projects
  });

  it('projectFilter does not affect real pinned slots', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    // Filter to project 20 only — but real pin to project 10 should still resolve
    const result = resolvePinnedCards(slots, cards, new Map(), new Set([20]));
    expect(result.get(1)).toBe(1); // real pin unaffected by filter
    expect(result.get(0)).toBe(2); // hotseat respects filter
  });

  it('hotseat has sticky behavior', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', createdAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[0, 2]]); // slot 0 was showing card 2
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(0)).toBe(2); // sticky — stays
  });

  it('hotseat keeps running card sticky when review card arrives', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[0, 2]]); // slot 0 was showing running card 2
    const result = resolvePinnedCards(slots, cards, prev);
    expect(result.get(0)).toBe(2); // strict sticky — stays
  });

  it('hotseat returns empty when no eligible cards exist', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'backlog' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.has(0)).toBe(false);
  });

  it('hotseat excludes cards in manual slots', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'manual', cardId: 1 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.has(0)).toBe(false); // card 1 is in manual slot, excluded
  });

  // ─── Locked slots (focus protection) ──────────────────────────────────────

  it('locked slot keeps its previous card unconditionally', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 'all' },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'review', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const prev = new Map([[1, 2]]); // slot 1 showing card 2
    // Lock slot 1 — card 2 should stay even though card 1 is older
    const result = resolvePinnedCards(slots, cards, prev, undefined, new Set([1]));
    expect(result.get(1)).toBe(2); // locked — stays
    expect(result.get(0)).toBe(1); // hotseat gets card 1
  });

  it('locked slot card is excluded from other slots', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
    ];
    const prev = new Map([[0, 1]]); // hotseat showing card 1
    // Lock hotseat — card 1 stays and is excluded from the pinned slot
    const result = resolvePinnedCards(slots, cards, prev, undefined, new Set([0]));
    expect(result.get(0)).toBe(1); // locked
    expect(result.has(1)).toBe(false); // card 1 excluded, nothing else available
  });

  it('locked slot with deleted card is ignored', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const cards: Card[] = []; // card 1 was deleted
    const prev = new Map([[0, 1]]);
    const result = resolvePinnedCards(slots, cards, prev, undefined, new Set([0]));
    expect(result.has(0)).toBe(false); // card gone, lock ignored
  });
});
