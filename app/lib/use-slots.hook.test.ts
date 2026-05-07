// @vitest-environment jsdom
// app/lib/use-slots.hook.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSlots } from './use-slots';
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

beforeEach(() => {
  localStorage.clear();
});

// ─── Persistence ──────────────────────────────────────────────────────────────

describe('persistence', () => {
  it('reads initial state from localStorage', () => {
    const stored: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const { result } = renderHook(() => useSlots(2, []));
    expect(result.current.slots).toEqual(stored);
  });

  it('writes to localStorage when a slot changes', () => {
    const { result } = renderHook(() => useSlots(2, []));
    act(() => result.current.pinSlot(1, 10));
    const stored = JSON.parse(localStorage.getItem('dispatcher-slots')!);
    expect(stored[1]).toEqual({ type: 'pinned', projectId: 10 });
  });

  it('defaults to [{ type: "empty" }] when localStorage is empty', () => {
    const { result } = renderHook(() => useSlots(1, []));
    expect(result.current.slots).toEqual([{ type: 'empty' }]);
  });

  it('survives invalid JSON in localStorage gracefully', () => {
    localStorage.setItem('dispatcher-slots', 'not-json');
    const { result } = renderHook(() => useSlots(1, []));
    expect(result.current.slots).toEqual([{ type: 'empty' }]);
  });
});

// ─── Migration ────────────────────────────────────────────────────────────────

describe('migration from old format', () => {
  it('migrates old columnSlots + columnPins to SlotState[]', () => {
    localStorage.setItem('dispatcher-column-slots', JSON.stringify([null, 5, null]));
    localStorage.setItem('dispatcher-column-pins', JSON.stringify([null, null, 10]));
    const { result } = renderHook(() => useSlots(3, []));
    expect(result.current.slots[0]).toEqual({ type: 'empty' });
    expect(result.current.slots[1]).toEqual({ type: 'manual', cardId: 5 });
    expect(result.current.slots[2]).toEqual({ type: 'pinned', projectId: 10 });
  });

  it('removes old localStorage keys after migration', () => {
    localStorage.setItem('dispatcher-column-slots', JSON.stringify([null]));
    localStorage.setItem('dispatcher-column-pins', JSON.stringify([null]));
    renderHook(() => useSlots(1, []));
    expect(localStorage.getItem('dispatcher-column-slots')).toBeNull();
    expect(localStorage.getItem('dispatcher-column-pins')).toBeNull();
  });

  it('writes migrated state to new key', () => {
    localStorage.setItem('dispatcher-column-slots', JSON.stringify([null, 5]));
    localStorage.setItem('dispatcher-column-pins', JSON.stringify([null, null]));
    renderHook(() => useSlots(2, []));
    const stored = JSON.parse(localStorage.getItem('dispatcher-slots')!);
    expect(stored[1]).toEqual({ type: 'manual', cardId: 5 });
  });

  it('prefers new key over old keys when both exist', () => {
    const newSlots: SlotState[] = [{ type: 'pinned', projectId: 99 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(newSlots));
    localStorage.setItem('dispatcher-column-slots', JSON.stringify([42]));
    const { result } = renderHook(() => useSlots(1, []));
    expect(result.current.slots[0]).toEqual({ type: 'pinned', projectId: 99 });
  });
});

// ─── Column count sync ────────────────────────────────────────────────────────

describe('column count sync', () => {
  it('grows slot array when columnCount increases', () => {
    const { result, rerender } = renderHook(({ count, cards }) => useSlots(count, cards), {
      initialProps: { count: 1, cards: [] as Card[] },
    });
    expect(result.current.slots).toHaveLength(1);
    rerender({ count: 3, cards: [] });
    expect(result.current.slots).toHaveLength(3);
    expect(result.current.slots[2]).toEqual({ type: 'empty' });
  });

  it('shrinks slot array when columnCount decreases', () => {
    const stored: SlotState[] = [{ type: 'manual', cardId: 1 }, { type: 'pinned', projectId: 10 }, { type: 'empty' }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const { result, rerender } = renderHook(({ count, cards }) => useSlots(count, cards), {
      initialProps: { count: 3, cards: [] as Card[] },
    });
    rerender({ count: 2, cards: [] });
    expect(result.current.slots).toHaveLength(2);
    expect(result.current.slots[0]).toEqual({ type: 'manual', cardId: 1 });
  });
});

// ─── Eviction through hook ────────────────────────────────────────────────────

describe('eviction', () => {
  it('evicts a manual slot when its card disappears from the cards array', () => {
    const cards = [makeCard({ id: 1 }), makeCard({ id: 2 })];
    const stored: SlotState[] = [
      { type: 'manual', cardId: 1 },
      { type: 'manual', cardId: 2 },
    ];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const { result, rerender } = renderHook(({ count, cards: c }) => useSlots(count, c), {
      initialProps: { count: 2, cards },
    });
    // Remove card 1
    rerender({ count: 2, cards: [makeCard({ id: 2 })] });
    expect(result.current.slots[0]).toEqual({ type: 'empty' }); // evicted
    expect(result.current.slots[1]).toEqual({ type: 'manual', cardId: 2 }); // kept
  });

  it('evicts a pinned override when its card disappears', () => {
    const cards = [makeCard({ id: 1 })];
    const stored: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10, cardId: 1 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const { result, rerender } = renderHook(({ count, cards: c }) => useSlots(count, c), {
      initialProps: { count: 2, cards },
    });
    // Remove card 1
    rerender({ count: 2, cards: [] });
    expect(result.current.slots[1]).toEqual({ type: 'pinned', projectId: 10 }); // override gone, pin kept
  });

  it('persists eviction to localStorage', () => {
    const stored: SlotState[] = [{ type: 'manual', cardId: 1 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const { rerender } = renderHook(({ count, cards }) => useSlots(count, cards), {
      initialProps: { count: 1, cards: [makeCard({ id: 1 })] },
    });
    rerender({ count: 1, cards: [] });
    const persisted = JSON.parse(localStorage.getItem('dispatcher-slots')!);
    expect(persisted[0]).toEqual({ type: 'empty' });
  });
});

// ─── Resolver integration ─────────────────────────────────────────────────────

describe('resolvedCards', () => {
  it('resolves a review card into a pinned slot', () => {
    const stored: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const cards = [makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' })];
    const { result } = renderHook(() => useSlots(2, cards));
    expect(result.current.resolvedCards.get(1)).toBe(1);
  });

  it('returns empty map when no pinned slots', () => {
    const { result } = renderHook(() => useSlots(1, [makeCard({ id: 1 })]));
    expect(result.current.resolvedCards.size).toBe(0);
  });

  it('updates resolvedCards when cards array changes', () => {
    const stored: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const { result, rerender } = renderHook(({ count, cards }) => useSlots(count, cards), {
      initialProps: { count: 2, cards: [] as Card[] },
    });
    expect(result.current.resolvedCards.size).toBe(0);
    rerender({
      count: 2,
      cards: [makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' })],
    });
    expect(result.current.resolvedCards.get(1)).toBe(1);
  });
});

// ─── Flash behavior ───────────────────────────────────────────────────────────

describe('flash', () => {
  it('flashes when resolver places a new card in a pinned slot', () => {
    const stored: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const { result, rerender } = renderHook(({ count, cards }) => useSlots(count, cards), {
      initialProps: { count: 2, cards: [] as Card[] },
    });
    expect(result.current.flashSlot).toBeNull();
    // A card enters review — resolver now picks it up
    rerender({
      count: 2,
      cards: [makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' })],
    });
    expect(result.current.flashSlot).toBe(1);
  });

  it('flashes on selectCard placement', () => {
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const { result } = renderHook(() => useSlots(2, cards));
    act(() => result.current.selectCard(1));
    expect(result.current.flashSlot).toBe(1); // placed in first empty slot >= 1
  });

  it('flashes on dropCard placement', () => {
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const { result } = renderHook(() => useSlots(2, cards));
    act(() => result.current.dropCard(1, 1, 10));
    expect(result.current.flashSlot).toBe(1);
  });

  it('flashes on closeSlot to confirm action', () => {
    const stored: SlotState[] = [{ type: 'manual', cardId: 1 }, { type: 'empty' }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const { result } = renderHook(() => useSlots(2, cards));
    act(() => result.current.closeSlot(0));
    expect(result.current.flashSlot).toBe(0);
  });

  it('releaseHotseat rotates to the next eligible card when available', async () => {
    const stored: SlotState[] = [{ type: 'manual', cardId: 1 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 20, column: 'running', updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const { result } = renderHook(() => useSlots(1, cards));

    act(() => result.current.releaseHotseat());

    await waitFor(() => {
      expect(result.current.resolvedCards.get(0)).toBe(2);
    });
    expect(result.current.slots[0]).toEqual({ type: 'empty' });
    expect(result.current.flashSlot).toBe(0);
  });

  it('releaseHotseat leaves the same card when it is the only eligible choice', async () => {
    const stored: SlotState[] = [{ type: 'manual', cardId: 1 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const cards = [makeCard({ id: 1, projectId: 10, column: 'review', updatedAt: '2026-03-20T01:00:00Z' })];
    const { result } = renderHook(() => useSlots(1, cards));

    act(() => result.current.releaseHotseat());

    await waitFor(() => {
      expect(result.current.resolvedCards.get(0)).toBe(1);
    });
    expect(result.current.slots[0]).toEqual({ type: 'empty' });
  });

  it('clearFlash resets flashSlot to null', () => {
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const { result } = renderHook(() => useSlots(2, cards));
    act(() => result.current.selectCard(1));
    expect(result.current.flashSlot).not.toBeNull();
    act(() => result.current.clearFlash());
    expect(result.current.flashSlot).toBeNull();
  });

  it('does not re-flash when resolver result is unchanged across renders', () => {
    const stored: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const cards = [makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' })];
    const { result, rerender } = renderHook(({ count, cards: c }) => useSlots(count, c), {
      initialProps: { count: 2, cards },
    });
    // First render: flash fires
    expect(result.current.flashSlot).toBe(1);
    act(() => result.current.clearFlash());
    expect(result.current.flashSlot).toBeNull();
    // Re-render with same cards — resolver produces same result
    rerender({ count: 2, cards: [...cards] });
    expect(result.current.flashSlot).toBeNull(); // no re-flash
  });

  it('flashes the slot that replaces running with review after a transition', async () => {
    const stored: SlotState[] = [{ type: 'pinned', projectId: 10 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));

    const runningCard = makeCard({
      id: 1,
      projectId: 10,
      column: 'running',
      updatedAt: '2026-03-20T01:00:00Z',
    });
    const reviewCard = makeCard({
      id: 2,
      projectId: 10,
      column: 'running',
      updatedAt: '2026-03-20T02:00:00Z',
    });
    const { result, rerender } = renderHook(({ count, cards }) => useSlots(count, cards), {
      initialProps: { count: 1, cards: [runningCard, reviewCard] },
    });

    expect(result.current.resolvedCards.get(0)).toBe(1);
    act(() => result.current.clearFlash());

    rerender({
      count: 1,
      cards: [runningCard, { ...reviewCard, column: 'review' }],
    });

    await waitFor(() => {
      expect(result.current.resolvedCards.get(0)).toBe(2);
    });
    expect(result.current.flashSlot).toBe(0);
  });
});

// ─── Action integration through hook ──────────────────────────────────────────

describe('actions through hook', () => {
  it('selectCard flashes existing card instead of duplicating', () => {
    const stored: SlotState[] = [{ type: 'manual', cardId: 1 }, { type: 'empty' }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const { result } = renderHook(() => useSlots(2, cards));
    act(() => result.current.selectCard(1));
    expect(result.current.flashSlot).toBe(0); // existing slot flashed
    expect(result.current.slots[1]).toEqual({ type: 'empty' }); // not duplicated
  });

  it('onCardCreated does nothing when pinned slot exists for project', () => {
    const stored: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const { result } = renderHook(() => useSlots(2, []));
    const before = result.current.slots;
    act(() => result.current.onCardCreated(99, 10));
    expect(result.current.slots).toBe(before); // same reference — no mutation
  });

  it('onCardCreated releases hotseat when no pinned slot for project', () => {
    const { result } = renderHook(() => useSlots(2, []));
    act(() => result.current.onCardCreated(99, 20));
    expect(result.current.slots[0]).toEqual({ type: 'empty' });
  });

  it('dropCard preserves pin when project matches', () => {
    const stored: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const cards = [makeCard({ id: 1, projectId: 10, column: 'done' })];
    const { result } = renderHook(() => useSlots(2, cards));
    act(() => result.current.dropCard(1, 1, 10));
    expect(result.current.slots[1]).toEqual({ type: 'pinned', projectId: 10, cardId: 1 });
  });

  it('dropCard clears pin when project differs', () => {
    const stored: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const cards = [makeCard({ id: 1, projectId: 20 })];
    const { result } = renderHook(() => useSlots(2, cards));
    act(() => result.current.dropCard(1, 1, 20));
    expect(result.current.slots[1]).toEqual({ type: 'manual', cardId: 1 });
  });
});
