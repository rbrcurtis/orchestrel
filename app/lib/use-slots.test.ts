// app/lib/use-slots.test.ts
import { describe, it, expect } from 'vitest';
import {
  applySelectCard,
  applyDropCard,
  applyCloseSlot,
  applyPinSlot,
  applyOnCardCreated,
  applyEviction,
  applyColumnCountChange,
} from './use-slots';
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
    promptsSent: 0,
    turnsCompleted: 0,
    contextTokens: 0,
    contextWindow: 200000,
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    ...overrides,
  };
}

// ─── applySelectCard ────────────────────────────────────────────────────────

describe('applySelectCard', () => {
  it('flashes slot when card is already in a manual slot', () => {
    const slots: SlotState[] = [{ type: 'manual', cardId: 1 }, { type: 'empty' }];
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const resolved = new Map<number, number>();
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next).toBe(slots); // no mutation
    expect(flashIndex).toBe(0);
  });

  it('flashes slot when card is shown via resolver in a pinned slot', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const resolved = new Map([[1, 1]]); // slot 1 currently shows card 1
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next).toBe(slots);
    expect(flashIndex).toBe(1);
  });

  it('flashes slot when card is shown as a pinned override', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10, cardId: 1 }];
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const resolved = new Map<number, number>();
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next).toBe(slots);
    expect(flashIndex).toBe(1);
  });

  it('places card as override in empty pinned slot for matching project', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [makeCard({ id: 1, projectId: 10, column: 'done' })];
    const resolved = new Map<number, number>(); // no resolver result for slot 1
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next[1]).toEqual({ type: 'pinned', projectId: 10, cardId: 1 });
    expect(flashIndex).toBe(1);
  });

  it('does not treat "all" pinned slot as project-specific for override placement', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 'all' }];
    const cards = [makeCard({ id: 1, projectId: 10, column: 'done' })];
    const resolved = new Map<number, number>();
    // "all" slots don't match a specific projectId, so card goes to slot 0 fallback
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
    expect(flashIndex).toBe(0);
  });

  it('does not use a pinned slot as a fallback empty slot for different project', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 20 }];
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const resolved = new Map<number, number>();
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 }); // falls back to slot 0
    expect(flashIndex).toBe(0);
  });

  it('places card in first empty slot at index >= 1', () => {
    const slots: SlotState[] = [{ type: 'manual', cardId: 99 }, { type: 'empty' }, { type: 'empty' }];
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const resolved = new Map<number, number>();
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next[1]).toEqual({ type: 'manual', cardId: 1 });
    expect(flashIndex).toBe(1);
  });

  it('falls back to slot 0 when no empty slots at index >= 1', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'manual', cardId: 99 }];
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const resolved = new Map<number, number>();
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
    expect(flashIndex).toBe(0);
  });

  it('does not place card in pinned-with-resolver-result slot when looking for empty pinned slot', () => {
    // Slot 1 is pinned to project 10 and has a resolver result — not empty
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [makeCard({ id: 1, projectId: 10, column: 'done' })];
    const resolved = new Map([[1, 99]]); // slot 1 has a resolver result (card 99)
    // Card 1 is for project 10 but the pinned slot is occupied — should fall back
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 }); // slot 0 fallback
    expect(flashIndex).toBe(0);
  });

  it('handles card with null projectId — places in first empty non-hotseat slot', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'empty' }];
    const cards = [makeCard({ id: 1, projectId: null })];
    const resolved = new Map<number, number>();
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next[1]).toEqual({ type: 'manual', cardId: 1 });
    expect(flashIndex).toBe(1);
  });

  it('places override in second pinned slot when first is occupied by resolver', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
    ];
    const cards = [makeCard({ id: 1, projectId: 10, column: 'done' })];
    const resolved = new Map([[1, 99]]); // slot 1 is occupied by resolver
    const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
    expect(next[2]).toEqual({ type: 'pinned', projectId: 10, cardId: 1 }); // goes to slot 2
    expect(flashIndex).toBe(2);
  });
});

// ─── applyDropCard ───────────────────────────────────────────────────────────

describe('applyDropCard', () => {
  it('places card as manual in an empty target slot', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'empty' }];
    const { slots: next, flashIndex } = applyDropCard(slots, 1, 5, 10);
    expect(next[1]).toEqual({ type: 'manual', cardId: 5 });
    expect(flashIndex).toBe(1);
  });

  it('preserves pin when card project matches target pinned slot', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const { slots: next } = applyDropCard(slots, 1, 5, 10);
    expect(next[1]).toEqual({ type: 'pinned', projectId: 10, cardId: 5 });
  });

  it('converts to manual when card project differs from target pin', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const { slots: next } = applyDropCard(slots, 1, 5, 20);
    expect(next[1]).toEqual({ type: 'manual', cardId: 5 });
  });

  it('converts to manual when cardProjectId is null', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const { slots: next } = applyDropCard(slots, 1, 5, null);
    expect(next[1]).toEqual({ type: 'manual', cardId: 5 });
  });

  it('removes card from its previous manual slot', () => {
    const slots: SlotState[] = [{ type: 'manual', cardId: 1 }, { type: 'empty' }];
    const { slots: next } = applyDropCard(slots, 1, 1, null);
    expect(next[0]).toEqual({ type: 'empty' }); // deduped
    expect(next[1]).toEqual({ type: 'manual', cardId: 1 });
  });

  it('clears override from source pinned slot but keeps pin', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10, cardId: 1 }, { type: 'empty' }];
    const { slots: next } = applyDropCard(slots, 2, 1, null);
    expect(next[1]).toEqual({ type: 'pinned', projectId: 10 }); // pin kept, override cleared
    expect(next[2]).toEqual({ type: 'manual', cardId: 1 });
  });

  it('converts to manual when dropping onto an "all" pinned slot', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 'all' }];
    const { slots: next } = applyDropCard(slots, 1, 5, 10);
    // "all" pin has no specific projectId to match, so becomes manual
    expect(next[1]).toEqual({ type: 'manual', cardId: 5 });
  });

  it('does not touch a resolver-picked pinned slot (no stored cardId) when its card is moved', () => {
    // Slot 1 is pinned but card 1 was shown there by the resolver (not stored).
    // Dropping card 1 elsewhere should leave slot 1 untouched — resolver will refill naturally.
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 }, // resolver showed card 1 here, but not in state
    ];
    const { slots: next } = applyDropCard(slots, 0, 1, null);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
    expect(next[1]).toEqual({ type: 'pinned', projectId: 10 }); // untouched
  });

  it('replaces an existing manual card in the target slot', () => {
    const slots: SlotState[] = [
      { type: 'manual', cardId: 99 },
      { type: 'manual', cardId: 1 },
    ];
    const { slots: next } = applyDropCard(slots, 0, 1, null);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 }); // replaced card 99
    expect(next[1]).toEqual({ type: 'empty' }); // source cleared
  });
});

// ─── applyCloseSlot ──────────────────────────────────────────────────────────

describe('applyCloseSlot', () => {
  it('sets a manual slot to empty', () => {
    const slots: SlotState[] = [{ type: 'manual', cardId: 1 }];
    expect(applyCloseSlot(slots, 0)[0]).toEqual({ type: 'empty' });
  });

  it('preserves pin when closing a pinned slot with an override', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10, cardId: 5 }];
    expect(applyCloseSlot(slots, 1)[1]).toEqual({ type: 'pinned', projectId: 10 });
  });

  it('preserves pin when closing a pinned slot without an override', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    expect(applyCloseSlot(slots, 1)[1]).toEqual({ type: 'pinned', projectId: 10 });
  });

  it('sets an already-empty slot to empty without error', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    expect(applyCloseSlot(slots, 0)[0]).toEqual({ type: 'empty' });
  });
});

// ─── applyPinSlot ────────────────────────────────────────────────────────────

describe('applyPinSlot', () => {
  it('pins a slot to a project', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'empty' }];
    expect(applyPinSlot(slots, 1, 10)[1]).toEqual({ type: 'pinned', projectId: 10 });
  });

  it('is a no-op for slot 0', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    expect(applyPinSlot(slots, 0, 10)).toBe(slots);
  });

  it('clears an existing card when pinning a manual slot', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'manual', cardId: 5 }];
    expect(applyPinSlot(slots, 1, 10)[1]).toEqual({ type: 'pinned', projectId: 10 });
  });

  it('changes the project when re-pinning a pinned slot', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10, cardId: 5 }];
    expect(applyPinSlot(slots, 1, 20)[1]).toEqual({ type: 'pinned', projectId: 20 });
  });

  it('re-pinning to the same project clears any existing override', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10, cardId: 5 }];
    expect(applyPinSlot(slots, 1, 10)[1]).toEqual({ type: 'pinned', projectId: 10 }); // override gone
  });

  it('pins a slot to "all" projects', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'empty' }];
    expect(applyPinSlot(slots, 1, 'all')[1]).toEqual({ type: 'pinned', projectId: 'all' });
  });
});

// ─── applyOnCardCreated ──────────────────────────────────────────────────────

describe('applyOnCardCreated', () => {
  it('places card in slot 0 when no pinned slot for the project', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'empty' }];
    const { slots: next, flashIndex } = applyOnCardCreated(slots, 1, 10);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
    expect(flashIndex).toBe(0);
  });

  it('does nothing when a pinned slot exists for the project', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const { slots: next, flashIndex } = applyOnCardCreated(slots, 1, 10);
    expect(next).toBe(slots);
    expect(flashIndex).toBeNull();
  });

  it('places card in slot 0 when projectId is null', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const { slots: next, flashIndex } = applyOnCardCreated(slots, 1, null);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
    expect(flashIndex).toBe(0);
  });

  it('does nothing when multiple pinned slots exist for the project', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 10 },
    ];
    const { slots: next, flashIndex } = applyOnCardCreated(slots, 1, 10);
    expect(next).toBe(slots);
    expect(flashIndex).toBeNull();
  });

  it('places card in slot 0 when only an "all" pin exists (not project-specific)', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 'all' }];
    const { slots: next, flashIndex } = applyOnCardCreated(slots, 1, 10);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
    expect(flashIndex).toBe(0);
  });
});

// ─── applyEviction ───────────────────────────────────────────────────────────

describe('applyEviction', () => {
  it('clears a manual slot when the card is deleted', () => {
    const slots: SlotState[] = [{ type: 'manual', cardId: 1 }];
    expect(applyEviction(slots, new Set([2]))[0]).toEqual({ type: 'empty' });
  });

  it('clears a pinned override when the override card is deleted', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10, cardId: 1 }];
    const result = applyEviction(slots, new Set([99]));
    expect(result[1]).toEqual({ type: 'pinned', projectId: 10 }); // pin preserved, override gone
  });

  it('leaves pinned slots without overrides untouched', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    expect(applyEviction(slots, new Set())).toBe(slots);
  });

  it('returns same reference when no eviction needed', () => {
    const slots: SlotState[] = [{ type: 'manual', cardId: 1 }];
    expect(applyEviction(slots, new Set([1]))).toBe(slots);
  });

  it('evicts multiple slots in one pass', () => {
    const slots: SlotState[] = [
      { type: 'manual', cardId: 1 },
      { type: 'manual', cardId: 2 },
      { type: 'pinned', projectId: 10, cardId: 3 },
    ];
    const next = applyEviction(slots, new Set()); // all cards gone
    expect(next[0]).toEqual({ type: 'empty' });
    expect(next[1]).toEqual({ type: 'empty' });
    expect(next[2]).toEqual({ type: 'pinned', projectId: 10 }); // override cleared, pin kept
  });

  it('does not touch empty slots or pinned slots without overrides', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    expect(applyEviction(slots, new Set())).toBe(slots); // same reference — nothing to evict
  });
});

// ─── applyColumnCountChange ──────────────────────────────────────────────────

describe('applyColumnCountChange', () => {
  it('appends empty slots when count grows', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    const next = applyColumnCountChange(slots, 3);
    expect(next).toHaveLength(3);
    expect(next[1]).toEqual({ type: 'empty' });
    expect(next[2]).toEqual({ type: 'empty' });
  });

  it('drops empty slots first when shrinking', () => {
    const slots: SlotState[] = [
      { type: 'manual', cardId: 1 },
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'empty' },
    ];
    const next = applyColumnCountChange(slots, 2);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
    expect(next[1]).toEqual({ type: 'pinned', projectId: 10 });
  });

  it('drops manual slots after empty slots when shrinking', () => {
    const slots: SlotState[] = [
      { type: 'pinned', projectId: 10 },
      { type: 'manual', cardId: 1 },
      { type: 'pinned', projectId: 20 },
    ];
    // Need to drop 1 — no empty slots, so drop the manual slot
    const next = applyColumnCountChange(slots, 2);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ type: 'pinned', projectId: 10 });
    expect(next[1]).toEqual({ type: 'pinned', projectId: 20 });
  });

  it('drops rightmost empty slot first among multiple empties', () => {
    const slots: SlotState[] = [
      { type: 'empty' },
      { type: 'pinned', projectId: 10 },
      { type: 'empty' },
      { type: 'empty' },
    ];
    const next = applyColumnCountChange(slots, 3);
    expect(next).toHaveLength(3);
    // Dropped the rightmost empty (index 3)
    expect(next[0]).toEqual({ type: 'empty' });
    expect(next[1]).toEqual({ type: 'pinned', projectId: 10 });
    expect(next[2]).toEqual({ type: 'empty' });
  });

  it('drops pinned slots last when no empty or manual slots remain', () => {
    const slots: SlotState[] = [
      { type: 'manual', cardId: 1 },
      { type: 'pinned', projectId: 10 },
      { type: 'pinned', projectId: 20 },
    ];
    const next = applyColumnCountChange(slots, 1);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 }); // slot 0 always preserved
  });

  it('never drops slot 0', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const next = applyColumnCountChange(slots, 1);
    expect(next).toHaveLength(1);
    // Slot 0 is empty, slot 1 is pinned — but slot 0 is always kept
    expect(next[0]).toEqual({ type: 'empty' });
  });

  it('drops multiple slots in priority order', () => {
    const slots: SlotState[] = [
      { type: 'manual', cardId: 1 }, // slot 0 — never drop
      { type: 'pinned', projectId: 10 },
      { type: 'empty' },
      { type: 'manual', cardId: 2 },
      { type: 'empty' },
    ];
    // Drop 3: first drop empties (indices 4, 2), then manual (index 3)
    const next = applyColumnCountChange(slots, 2);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
    expect(next[1]).toEqual({ type: 'pinned', projectId: 10 });
  });

  it('returns same reference when count is unchanged', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    expect(applyColumnCountChange(slots, 1)).toBe(slots);
  });

  it('shrinks to 1 preserving slot 0 regardless of type', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }, { type: 'manual', cardId: 1 }];
    const next = applyColumnCountChange(slots, 1);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ type: 'empty' });
  });
});
