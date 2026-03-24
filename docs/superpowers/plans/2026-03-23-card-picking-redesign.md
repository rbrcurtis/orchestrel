# Card Picking Logic Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-array `columnSlots`/`columnPins` model and its MobX reaction with a single `SlotState[]` array and a pure resolver called at render time.

**Architecture:** All slot state lives in a single typed array persisted to localStorage. The card displayed by a pinned slot is computed fresh each render via `resolvePinnedCards` — it is never stored. All state mutations are pure functions that accept and return `SlotState[]`, making them independently testable without React.

**Tech Stack:** React, MobX (observer for reactivity only), TypeScript strict, Vitest, localStorage

**Spec:** `docs/superpowers/specs/2026-03-23-card-picking-redesign.md`
**Requirements:** `docs/specs/card-picking-requirements.md`

---

## File Map

| File                             | Change                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `app/lib/resolve-pin.ts`         | **Rewrite** — add `SlotState` type, replace `resolvePins` with `resolvePinnedCards`         |
| `app/lib/resolve-pin.test.ts`    | **Rewrite** — tests for `resolvePinnedCards` with new sort order                            |
| `app/lib/use-slots.ts`           | **Create** — pure action functions + `useSlots` hook                                        |
| `app/lib/use-slots.test.ts`      | **Create** — unit tests for all pure action functions (no React deps)                       |
| `app/lib/use-slots.hook.test.ts` | **Create** — hook-level tests: flash, eviction, persistence, migration (`renderHook`)       |
| `app/routes/board.tsx`           | **Modify** — consume `useSlots`, update `ColumnSlot` props, update `NewCardDetail` callback |
| `app/routes/board.index.tsx`     | **Modify** — use `dropCard` from outlet context in `handleDragEnd`                          |
| `app/components/CardDetail.tsx`  | **Modify** — update `NewCardDetail.onCreated` to include `projectId`                        |

---

## Chunk 1: SlotState type + resolver rewrite

### Task 1: Rewrite `resolve-pin.test.ts`

Write tests for the new `resolvePinnedCards` function before implementing it. These tests will fail until Task 2.

**Files:**

- Rewrite: `app/lib/resolve-pin.test.ts`

- [ ] **Step 1: Replace the test file**

```ts
// app/lib/resolve-pin.test.ts
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
    expect(result.get(1)).toBe(2); // oldest review card
  });

  it('resolves active running card when no review cards', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10 }];
    const cards = [
      makeCard({ id: 1, projectId: 10, column: 'running', queuePosition: null, updatedAt: '2026-03-20T01:00:00Z' }),
      makeCard({ id: 2, projectId: 10, column: 'running', queuePosition: null, updatedAt: '2026-03-20T02:00:00Z' }),
    ];
    const result = resolvePinnedCards(slots, cards);
    expect(result.get(1)).toBe(2); // newest updatedAt
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
    expect(resolvePinnedCards(slots, cards).get(1)).toBe(2); // active wins despite older updatedAt
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
    expect(result.get(1)).toBe(2); // queuePosition 1 first
    expect(result.get(2)).toBe(1); // queuePosition 2 second
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
    expect(result.get(1)).toBe(2); // newest first
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
    expect(result.get(1)).toBe(1); // oldest
    expect(result.get(2)).toBe(2); // next
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
    expect(result.get(1)).toBe(2); // card 1 excluded, picks card 2
  });

  it('excludes pinned override cards from resolution', () => {
    // Slot 1 has override (card 3 = done card). Slot 2 also pinned to same project.
    // Override is excluded, so slot 2 gets ranked[0]; slot 1 resolver also runs and gets ranked[1].
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
    expect(result.get(1)).toBe(1); // resolver picks card 1 (card 3 excluded)
    expect(result.get(2)).toBe(2); // resolver picks card 2
  });

  it('returns absent entry (not null) for pinned slot with no qualifying card', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10, cardId: 3 }];
    const cards = [makeCard({ id: 3, projectId: 10, column: 'done' })];
    const result = resolvePinnedCards(slots, cards);
    expect(result.has(1)).toBe(false); // absent — display logic falls back to override (card 3)
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
    expect(result.get(1)).toBe(2); // queuePosition 1
    expect(result.get(2)).toBe(3); // queuePosition 2
    expect(result.get(3)).toBe(1); // queuePosition 3
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
    // Card 1 (project A) is manually placed — should not affect project B resolution
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
    expect(result.get(1)).toBe(2); // card 1 excluded (manual), picks card 2
    expect(result.get(2)).toBe(3); // project B unaffected by project A exclusion
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run app/lib/resolve-pin.test.ts
```

Expected: All tests fail with import errors (function doesn't exist yet).

- [ ] **Step 3: Commit failing tests**

```bash
git add app/lib/resolve-pin.test.ts
git commit -m "test: rewrite resolve-pin tests for new resolvePinnedCards signature"
```

---

### Task 2: Implement `resolvePinnedCards` in `resolve-pin.ts`

**Files:**

- Rewrite: `app/lib/resolve-pin.ts`

- [ ] **Step 1: Replace the file**

```ts
// app/lib/resolve-pin.ts
import type { Card } from '../../src/shared/ws-protocol';

export type SlotState =
  | { type: 'pinned'; projectId: number; cardId?: number }
  | { type: 'manual'; cardId: number }
  | { type: 'empty' };

/**
 * Resolve which card each pinned slot should display.
 *
 * Returns Map<slotIndex, cardId> for every pinned slot with a qualifying card.
 * Pinned slots with no qualifying card are absent from the map.
 *
 * Cards already visible in any slot (manual or pinned override) are excluded.
 *
 * Priority per project:
 *   1. Review cards — oldest createdAt first
 *   2. Active running (queuePosition == null) — newest updatedAt first
 *   3. Queued running — queuePosition ascending, newest updatedAt as tiebreak
 */
export function resolvePinnedCards(slots: SlotState[], cards: Card[]): Map<number, number> {
  // Build exclusion set: cards already stored in any slot
  const usedCardIds = new Set<number>();
  for (const slot of slots) {
    if (slot.type === 'manual') usedCardIds.add(slot.cardId);
    else if (slot.type === 'pinned' && slot.cardId != null) usedCardIds.add(slot.cardId);
  }

  // Group pinned slot indices by projectId
  const projectSlots = new Map<number, number[]>();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.type !== 'pinned') continue;
    const existing = projectSlots.get(slot.projectId);
    if (existing) existing.push(i);
    else projectSlots.set(slot.projectId, [i]);
  }

  const result = new Map<number, number>();

  for (const [projectId, slotIndices] of projectSlots) {
    const eligible = cards.filter(
      (c) => c.projectId === projectId && (c.column === 'review' || c.column === 'running') && !usedCardIds.has(c.id),
    );

    const review = eligible.filter((c) => c.column === 'review').sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const activeRunning = eligible
      .filter((c) => c.column === 'running' && c.queuePosition == null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const queuedRunning = eligible
      .filter((c) => c.column === 'running' && c.queuePosition != null)
      .sort((a, b) => {
        const qDiff = (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
        return qDiff !== 0 ? qDiff : b.updatedAt.localeCompare(a.updatedAt);
      });

    const ranked = [...review, ...activeRunning, ...queuedRunning];

    for (let i = 0; i < slotIndices.length; i++) {
      if (i < ranked.length) result.set(slotIndices[i], ranked[i].id);
    }
  }

  return result;
}
```

- [ ] **Step 2: Run tests**

```bash
pnpm vitest run app/lib/resolve-pin.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/lib/resolve-pin.ts
git commit -m "feat: rewrite resolvePinnedCards with SlotState type and updated running sort"
```

---

## Chunk 2: Pure action functions + `useSlots` hook

### Task 3: Write `use-slots.test.ts`

Write tests for all pure action functions before implementing them.

**Files:**

- Create: `app/lib/use-slots.test.ts`

- [ ] **Step 1: Create the test file**

```ts
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

  it('sets a pinned slot (including override) to empty', () => {
    const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 10, cardId: 5 }];
    expect(applyCloseSlot(slots, 1)[1]).toEqual({ type: 'empty' });
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

  it('truncates from the right when count shrinks', () => {
    const slots: SlotState[] = [{ type: 'manual', cardId: 1 }, { type: 'pinned', projectId: 10 }, { type: 'empty' }];
    const next = applyColumnCountChange(slots, 2);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
    expect(next[1]).toEqual({ type: 'pinned', projectId: 10 });
  });

  it('returns same reference when count is unchanged', () => {
    const slots: SlotState[] = [{ type: 'empty' }];
    expect(applyColumnCountChange(slots, 1)).toBe(slots);
  });

  it('shrinks to 1, preserving slot 0', () => {
    const slots: SlotState[] = [{ type: 'manual', cardId: 1 }, { type: 'pinned', projectId: 10 }, { type: 'empty' }];
    const next = applyColumnCountChange(slots, 1);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run app/lib/use-slots.test.ts
```

Expected: All tests fail (module not found).

- [ ] **Step 3: Commit failing tests**

```bash
git add app/lib/use-slots.test.ts
git commit -m "test: add use-slots action function tests"
```

---

### Task 4: Write `use-slots.hook.test.ts` — hook-level tests

Tests for `useSlots` hook behavior that can't be covered by pure function tests: flash detection on resolver-driven card changes, eviction through the hook lifecycle, localStorage persistence, and migration from the old two-array format. Requires `@testing-library/react` and `jsdom`.

**Files:**

- Create: `app/lib/use-slots.hook.test.ts`

- [ ] **Step 1: Install test dependencies**

```bash
pnpm add -D @testing-library/react jsdom
```

- [ ] **Step 2: Create the hook test file**

The hook needs `cardStore.cards` as a `Card[]` input. In these tests we pass cards directly — no MobX mocking needed since the hook accepts `cards: Card[]` as a parameter.

For localStorage: each test clears relevant keys in `beforeEach`. For `act()`: state updates inside `renderHook` require wrapping in `act()`.

```ts
// @vitest-environment jsdom
// app/lib/use-slots.hook.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
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

  it('does not flash when a slot empties', () => {
    const stored: SlotState[] = [{ type: 'manual', cardId: 1 }, { type: 'empty' }];
    localStorage.setItem('dispatcher-slots', JSON.stringify(stored));
    const cards = [makeCard({ id: 1, projectId: 10 })];
    const { result } = renderHook(() => useSlots(2, cards));
    act(() => result.current.closeSlot(0));
    expect(result.current.flashSlot).toBeNull();
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

  it('onCardCreated places in slot 0 when no pinned slot for project', () => {
    const { result } = renderHook(() => useSlots(2, []));
    act(() => result.current.onCardCreated(99, 20));
    expect(result.current.slots[0]).toEqual({ type: 'manual', cardId: 99 });
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
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm vitest run app/lib/use-slots.hook.test.ts
```

Expected: All tests fail (module `./use-slots` not found).

- [ ] **Step 4: Commit failing tests**

```bash
git add app/lib/use-slots.hook.test.ts
git commit -m "test: add useSlots hook-level tests (flash, eviction, persistence, migration)"
```

---

### Task 5: Implement `use-slots.ts`

**Files:**

- Create: `app/lib/use-slots.ts`

- [ ] **Step 1: Create the file**

```ts
// app/lib/use-slots.ts
import { useState, useEffect, useRef } from 'react';
import { resolvePinnedCards, type SlotState } from './resolve-pin';
import type { Card } from '../../src/shared/ws-protocol';

// ─── localStorage helpers ────────────────────────────────────────────────────

const SLOTS_KEY = 'dispatcher-slots';
const OLD_SLOTS_KEY = 'dispatcher-column-slots';
const OLD_PINS_KEY = 'dispatcher-column-pins';

function readLocalStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalStorage<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ─── One-time migration from old two-array format ────────────────────────────

function migrateSlots(): SlotState[] | null {
  if (typeof window === 'undefined') return null;
  const oldSlots = readLocalStorage<(number | null)[] | null>(OLD_SLOTS_KEY, null);
  const oldPins = readLocalStorage<(number | null)[] | null>(OLD_PINS_KEY, null);
  if (oldSlots == null && oldPins == null) return null;

  const len = Math.max(oldSlots?.length ?? 0, oldPins?.length ?? 0);
  const result: SlotState[] = [];
  for (let i = 0; i < len; i++) {
    const pinId = oldPins?.[i] ?? null;
    const cardId = oldSlots?.[i] ?? null;
    if (pinId != null) {
      result.push({ type: 'pinned', projectId: pinId });
    } else if (cardId != null) {
      result.push({ type: 'manual', cardId });
    } else {
      result.push({ type: 'empty' });
    }
  }

  localStorage.removeItem(OLD_SLOTS_KEY);
  localStorage.removeItem(OLD_PINS_KEY);
  return result;
}

// ─── Pure action functions (exported for testing) ────────────────────────────

export function applySelectCard(
  slots: SlotState[],
  cardId: number,
  cards: Card[],
  resolvedCards: Map<number, number>,
): { slots: SlotState[]; flashIndex: number | null } {
  // Already visible anywhere?
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const displayed =
      slot.type === 'manual'
        ? slot.cardId
        : slot.type === 'pinned'
          ? (resolvedCards.get(i) ?? slot.cardId ?? null)
          : null;
    if (displayed === cardId) return { slots, flashIndex: i };
  }

  const card = cards.find((c) => c.id === cardId);
  const projectId = card?.projectId ?? null;
  const next = [...slots];

  // Empty pinned slot for this project?
  if (projectId != null) {
    for (let i = 1; i < next.length; i++) {
      const slot = next[i];
      if (
        slot.type === 'pinned' &&
        slot.projectId === projectId &&
        resolvedCards.get(i) == null &&
        slot.cardId == null
      ) {
        next[i] = { type: 'pinned', projectId, cardId };
        return { slots: next, flashIndex: i };
      }
    }
  }

  // First empty slot at index >= 1, else slot 0
  const emptyIdx = next.findIndex((s, i) => i >= 1 && s.type === 'empty');
  const targetIdx = emptyIdx >= 0 ? emptyIdx : 0;
  next[targetIdx] = { type: 'manual', cardId };
  return { slots: next, flashIndex: targetIdx };
}

export function applyDropCard(
  slots: SlotState[],
  slotIndex: number,
  cardId: number,
  cardProjectId: number | null,
): { slots: SlotState[]; flashIndex: number | null } {
  const next = [...slots];

  // Remove card from any other slot where it is stored in state
  for (let i = 0; i < next.length; i++) {
    if (i === slotIndex) continue;
    const slot = next[i];
    if (slot.type === 'manual' && slot.cardId === cardId) {
      next[i] = { type: 'empty' };
    } else if (slot.type === 'pinned' && slot.cardId === cardId) {
      // Clear override but preserve pin so the resolver can refill it
      next[i] = { type: 'pinned', projectId: slot.projectId };
    }
  }

  // Place card in target slot
  const target = slots[slotIndex];
  if (target.type === 'pinned' && cardProjectId === target.projectId) {
    next[slotIndex] = { type: 'pinned', projectId: target.projectId, cardId };
  } else {
    next[slotIndex] = { type: 'manual', cardId };
  }

  return { slots: next, flashIndex: slotIndex };
}

export function applyCloseSlot(slots: SlotState[], index: number): SlotState[] {
  const next = [...slots];
  next[index] = { type: 'empty' };
  return next;
}

export function applyPinSlot(slots: SlotState[], index: number, projectId: number): SlotState[] {
  if (index === 0) return slots;
  const next = [...slots];
  next[index] = { type: 'pinned', projectId };
  return next;
}

export function applyOnCardCreated(
  slots: SlotState[],
  cardId: number,
  projectId: number | null,
): { slots: SlotState[]; flashIndex: number | null } {
  if (projectId != null && slots.some((s) => s.type === 'pinned' && s.projectId === projectId)) {
    return { slots, flashIndex: null };
  }
  const next = [...slots];
  next[0] = { type: 'manual', cardId };
  return { slots: next, flashIndex: 0 };
}

export function applyEviction(slots: SlotState[], existingCardIds: Set<number>): SlotState[] {
  let changed = false;
  const next = slots.map((slot) => {
    if (slot.type === 'manual' && !existingCardIds.has(slot.cardId)) {
      changed = true;
      return { type: 'empty' as const };
    }
    if (slot.type === 'pinned' && slot.cardId != null && !existingCardIds.has(slot.cardId)) {
      changed = true;
      return { type: 'pinned' as const, projectId: slot.projectId };
    }
    return slot;
  });
  return changed ? next : slots;
}

export function applyColumnCountChange(slots: SlotState[], newCount: number): SlotState[] {
  if (slots.length === newCount) return slots;
  if (slots.length < newCount) {
    const padding: SlotState[] = Array(newCount - slots.length).fill({ type: 'empty' as const });
    return [...slots, ...padding];
  }
  return slots.slice(0, newCount);
}

// ─── useSlots hook ────────────────────────────────────────────────────────────

export type UseSlotsResult = {
  slots: SlotState[];
  resolvedCards: Map<number, number>;
  pinSlot: (index: number, projectId: number) => void;
  closeSlot: (index: number) => void;
  selectCard: (cardId: number) => void;
  dropCard: (slotIndex: number, cardId: number, cardProjectId: number | null) => void;
  onCardCreated: (cardId: number, projectId: number | null) => void;
  flashSlot: number | null;
  clearFlash: () => void;
};

export function useSlots(columnCount: number, cards: Card[]): UseSlotsResult {
  const [slots, setSlots] = useState<SlotState[]>(() => {
    const migrated = migrateSlots();
    if (migrated) {
      writeLocalStorage(SLOTS_KEY, migrated);
      return migrated;
    }
    return readLocalStorage<SlotState[]>(SLOTS_KEY, [{ type: 'empty' }]);
  });

  const [flashSlot, setFlashSlot] = useState<number | null>(null);

  // Sync array length with columnCount
  useEffect(() => {
    setSlots((prev) => {
      const next = applyColumnCountChange(prev, columnCount);
      if (next === prev) return prev;
      writeLocalStorage(SLOTS_KEY, next);
      return next;
    });
  }, [columnCount]);

  // Eviction — runs every render (hook lives inside observer(), MobX drives re-renders)
  useEffect(() => {
    const existingIds = new Set(cards.map((c) => c.id));
    setSlots((prev) => {
      const next = applyEviction(prev, existingIds);
      if (next === prev) return prev;
      writeLocalStorage(SLOTS_KEY, next);
      return next;
    });
  });

  // Compute resolver result fresh each render
  const resolvedCards = resolvePinnedCards(slots, cards);

  // Flash detection for resolver-driven card appearances
  const prevResolvedRef = useRef<Map<number, number>>(new Map());
  useEffect(() => {
    for (const [i, cardId] of resolvedCards) {
      if (prevResolvedRef.current.get(i) !== cardId) {
        setFlashSlot(i);
        break; // one flash at a time
      }
    }
    prevResolvedRef.current = resolvedCards;
  });

  function pinSlot(index: number, projectId: number) {
    const next = applyPinSlot(slots, index, projectId);
    if (next === slots) return;
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
  }

  function closeSlot(index: number) {
    const next = applyCloseSlot(slots, index);
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
  }

  function selectCard(cardId: number) {
    // resolvedCards is already computed above in the hook body — reuse it
    const { slots: next, flashIndex } = applySelectCard(slots, cardId, cards, resolvedCards);
    if (next !== slots) {
      setSlots(next);
      writeLocalStorage(SLOTS_KEY, next);
    }
    if (flashIndex != null) setFlashSlot(flashIndex);
  }

  function dropCard(slotIndex: number, cardId: number, cardProjectId: number | null) {
    const { slots: next, flashIndex } = applyDropCard(slots, slotIndex, cardId, cardProjectId);
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
    if (flashIndex != null) setFlashSlot(flashIndex);
  }

  function onCardCreated(cardId: number, projectId: number | null) {
    const { slots: next, flashIndex } = applyOnCardCreated(slots, cardId, projectId);
    if (next === slots) return;
    setSlots(next);
    writeLocalStorage(SLOTS_KEY, next);
    if (flashIndex != null) setFlashSlot(flashIndex);
  }

  return {
    slots,
    resolvedCards,
    pinSlot,
    closeSlot,
    selectCard,
    dropCard,
    onCardCreated,
    flashSlot,
    clearFlash: () => setFlashSlot(null),
  };
}
```

- [ ] **Step 2: Run pure function tests**

```bash
pnpm vitest run app/lib/use-slots.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Run hook tests**

```bash
pnpm vitest run app/lib/use-slots.hook.test.ts
```

Expected: All tests pass.

- [ ] **Step 4: Run all tests to confirm no regressions**

```bash
pnpm vitest run
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/lib/use-slots.ts
git commit -m "feat: add useSlots hook with pure action functions"
```

---

## Chunk 3: Board integration

### Task 6: Update `board.tsx` and `CardDetail.tsx`

Wire `useSlots` into `board.tsx` and update `ColumnSlot` and `NewCardDetail`.

**Files:**

- Modify: `app/routes/board.tsx`
- Modify: `app/components/CardDetail.tsx` (update `NewCardDetail.onCreated` type)

- [ ] **Step 1: Update `NewCardDetail` callback type in `CardDetail.tsx`**

Find the `NewCardDetail` component's props type and update `onCreated` to include `projectId`:

```ts
// Find this type (exact line may vary) and update:
onCreated: (id: number, projectId: number | null) => void;
```

Find where the callback is invoked inside `NewCardDetail` (after a successful card create API call) and include the `projectId`. The local variable inside `NewCardDetail` after creation is named `card` (i.e. `const card = await cardStore.createCard(...)`):

```ts
// Find the onCreated(...) call and update to pass projectId:
onCreated(card.id, card.projectId ?? null);
```

After editing, verify the file compiles:

```bash
pnpm typecheck 2>&1 | head -30
```

- [ ] **Step 2: Replace slot/pin state in `board.tsx` with `useSlots`**

Remove from `board.tsx`:

- The `COLUMN_SLOTS_KEY` and `COLUMN_PINS_KEY` constants
- `columnSlots` and `columnPins` state declarations
- `updateSlots` and `updatePins` callbacks
- The `useEffect` that wires the MobX reaction (lines ~194–224)
- The `useEffect` that syncs `columnPins` length with `columnCount`
- The eviction `useEffect`
- The `pinSlot` function

Add after the `columnCount` state declaration. Note the hook's `selectCard` is aliased as `hookSelectCard` to avoid colliding with the wrapper function defined below:

```ts
const allCards = Array.from(cardStore.cards.values());
const {
  slots: columnSlots,
  resolvedCards,
  pinSlot,
  closeSlot,
  selectCard: hookSelectCard,
  dropCard,
  onCardCreated,
  flashSlot,
  clearFlash: clearFlashSlot,
} = useSlots(columnCount, allCards);
```

Add the import at the top of the file:

```ts
import { useSlots } from '~/lib/use-slots';
import type { SlotState } from '~/lib/resolve-pin';
```

Note: `columnSlots` is kept as the name for the variable that holds `slots` to minimise downstream churn.

- [ ] **Step 3: Update `selectCard` wrapper in `board.tsx`**

The current `selectCard` function has mobile-specific logic. Replace it with a wrapper that delegates the desktop path to the hook:

```ts
function selectCard(id: number | null) {
  setNewCardColumn(null);
  if (!isDesktop) {
    if (id != null && mobileCardId === id) {
      setMobileFlash(true);
      return;
    }
    setMobileCardId(id);
    return;
  }
  if (id === null) return;
  // Delegate to hook — handles flash, dedup, pinned slot lookup
  hookSelectCard(id);
}
```

- [ ] **Step 4: Update the flash state references**

The existing `flashSlot` state and `setFlashSlot` are now provided by the hook. Remove:

```ts
const [flashSlot, setFlashSlot] = useState<number | null>(null);
```

The hook returns `flashSlot` and `clearFlash`. The only remaining `setFlashSlot` call at this point is `setFlashSlot(null)` inside the `onFlashDone` lambda — update it to `clearFlashSlot()`. The `setFlashSlot(existingIdx)` call in the old `selectCard` body was removed in Step 3, and the `setFlashSlot(i)` inside the MobX reaction was removed in Step 2.

- [ ] **Step 5: Update `ColumnSlot` props in the render section**

In the `columnSlots.map(...)` render section, compute `displayedCardId` and `pinProjectId` from the new model:

```tsx
{
  columnSlots.map((slot, idx) => {
    const pinProjectId = slot.type === 'pinned' ? slot.projectId : null;
    const displayedCardId =
      slot.type === 'manual'
        ? slot.cardId
        : slot.type === 'pinned'
          ? (resolvedCards.get(idx) ?? slot.cardId ?? null)
          : null;
    const slotCard = displayedCardId != null ? cardStore.getCard(displayedCardId) : undefined;
    const slotProject = slotCard?.projectId ? projectStore.getProject(slotCard.projectId) : null;
    const pinProject = pinProjectId != null ? projectStore.getProject(pinProjectId) : null;
    const borderColor = pinProject?.color ?? slotProject?.color ?? null;
    return (
      <ColumnSlot
        key={idx}
        index={idx}
        slot={slot}
        cardId={displayedCardId}
        borderColor={borderColor}
        flash={flashSlot === idx}
        onFlashDone={clearFlashSlot}
        newCardColumn={newCardColumn}
        dropCard={dropCard}
        pinProjectId={pinProjectId}
        onPin={(projectId) => pinSlot(idx, projectId)}
        setNewCardColumn={setNewCardColumn}
        closeSlot={closeSlot}
        onCardCreated={onCardCreated}
      />
    );
  });
}
```

- [ ] **Step 6: Update `ColumnSlot` props type and component**

Update `ColumnSlotProps`:

```ts
type ColumnSlotProps = {
  index: number;
  slot: SlotState;
  cardId: number | null;
  borderColor: string | null;
  flash: boolean;
  onFlashDone: () => void;
  newCardColumn: string | null;
  dropCard: (slotIndex: number, cardId: number, cardProjectId: number | null) => void;
  pinProjectId: number | null;
  onPin: (projectId: number) => void;
  setNewCardColumn: (col: string | null) => void;
  closeSlot: (index: number) => void;
  onCardCreated: (cardId: number, projectId: number | null) => void;
};
```

Inside `ColumnSlot`, update the drag handlers to use `dropCard`:

```ts
// Replace handleDrop entirely:
function handleDrop(e: React.DragEvent) {
  e.preventDefault();
  setDragOver(false);

  // Column-to-column slot drag
  const slotData = e.dataTransfer.getData('application/x-card-slot');
  if (slotData) {
    const { cardId: srcCardId, slotIndex: srcIdx } = JSON.parse(slotData) as { cardId: number; slotIndex: number };
    if (srcIdx === index) return; // self-drop guard
    const srcCard = cardStore.getCard(srcCardId);
    dropCard(index, srcCardId, srcCard?.projectId ?? null);
    return;
  }

  // Kanban card drag (HTML5 path)
  const kanbanData = e.dataTransfer.getData('application/x-kanban-card');
  if (kanbanData) {
    const { cardId: draggedId } = JSON.parse(kanbanData) as { cardId: number };
    const draggedCard = cardStore.getCard(draggedId);
    dropCard(index, draggedId, draggedCard?.projectId ?? null);
  }
}
```

Add `useCardStore` import to `ColumnSlot` (it already uses `useProjectStore`):

```ts
const cardStore = useCardStore();
```

Update the `NewCardDetail` `onCreated` callback in the slot 0 render:

```tsx
<NewCardDetail
  column={newCardColumn}
  onCreated={(id, projectId) => {
    setDraftColor(null);
    setNewCardColumn(null);
    onCardCreated(id, projectId);
  }}
  onClose={() => {
    setDraftColor(null);
    setNewCardColumn(null);
  }}
  onColorChange={setDraftColor}
/>
```

- [ ] **Step 7: Update outlet context**

```ts
// Before:
context={{ search, projectFilter, selectedCardId, selectCard, startNewCard, updateSlots, columnSlots }}

// After:
context={{ search, projectFilter, selectedCardId, selectCard, startNewCard, dropCard, onCardCreated, slots: columnSlots }}
```

Also update the `BoardContext` type in `board.index.tsx`:

```ts
type BoardContext = {
  search: string;
  projectFilter: Set<number>;
  selectedCardId: number | null;
  selectCard: (id: number | null) => void;
  startNewCard: (column: string) => void;
  dropCard: (slotIndex: number, cardId: number, cardProjectId: number | null) => void;
  onCardCreated: (cardId: number, projectId: number | null) => void;
  slots: SlotState[];
};
```

Import `SlotState` in `board.index.tsx`:

```ts
import type { SlotState } from '~/lib/resolve-pin';
```

Note: in `board.index.tsx`, the destructuring reads `slots` from the context. The `columnSlots` local variable in `board.tsx` is aliased to `slots` at the context boundary (`slots: columnSlots`).

- [ ] **Step 8: Typecheck**

```bash
pnpm typecheck 2>&1 | head -50
```

Fix any type errors before continuing. Common issues:

- `updateSlots` / `updatePins` calls still remaining somewhere — replace with `dropCard`
- `columnPins` references — these are gone, use `slot.type === 'pinned' ? slot.projectId : null`

- [ ] **Step 9: Commit**

```bash
git add app/routes/board.tsx app/components/CardDetail.tsx app/routes/board.index.tsx
git commit -m "feat: wire useSlots into board.tsx, update ColumnSlot and NewCardDetail"
```

---

### Task 7: Update `board.index.tsx`

Fix the `handleDragEnd` to use `dropCard` instead of `updateSlots`, closing BUG-1.

Note: The `BoardContext` type and `SlotState` import were already updated in Task 6 Step 7. This task only needs to update the runtime destructuring and the drag handler.

**Files:**

- Modify: `app/routes/board.index.tsx`

- [ ] **Step 1: Update the outlet context destructuring**

```ts
// Before:
const { search, projectFilter, selectCard, startNewCard, updateSlots } = useOutletContext<BoardContext>();

// After:
const { search, projectFilter, selectCard, startNewCard, dropCard } = useOutletContext<BoardContext>();
```

- [ ] **Step 2: Replace `updateSlots` with `dropCard` in `handleDragEnd`**

Find the section (around lines 234–251) that handles drops onto column slots:

```ts
// Before:
if (slotIdx != null) {
  const draggedId = active.id as number;
  updateSlots((prev) => {
    const next = [...prev];
    for (let i = 0; i < next.length; i++) {
      if (next[i] === draggedId) next[i] = null;
    }
    next[slotIdx] = draggedId;
    return next;
  });
  setActiveId(null);
  setDragOverride(null);
  snapshotRef.current = null;
  return;
}

// After:
if (slotIdx != null) {
  const draggedId = active.id as number;
  const draggedCard = Object.values(columns)
    .flat()
    .find((c) => c.id === draggedId);
  dropCard(slotIdx, draggedId, draggedCard?.projectId ?? null);
  setActiveId(null);
  setDragOverride(null);
  snapshotRef.current = null;
  return;
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck 2>&1 | head -50
```

Fix any remaining errors.

- [ ] **Step 4: Run all tests**

```bash
pnpm vitest run
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/routes/board.index.tsx
git commit -m "fix: use dropCard in dnd-kit handleDragEnd, clearing pin on slot drop"
```

---

### Task 8: Smoke test in browser

- [ ] **Step 1: Start dev server**

```bash
pnpm dev
```

Navigate to `http://localhost:6194`.

- [ ] **Step 2: Verify basic slot behavior**

- [ ] Open a card from the kanban → appears in slot 0
- [ ] Add a second column, pin it to a project → shows resolver card or "No review/running cards"
- [ ] Move a card to review → it appears in the pinned slot with flash
- [ ] Click X on pinned slot → slot goes empty (shows project picker)
- [ ] Drag a card from kanban onto a pinned slot for a different project → pin is cleared, card stays
- [ ] Drag a card from kanban onto a pinned slot for the same project → pin preserved, card shows
- [ ] Create a new card for a pinned project → slot 0 stays empty, card appears in pinned slot if it qualifies
- [ ] Create a new card for an unpinned project → card appears in slot 0

- [ ] **Step 3: Final commit**

```bash
git add app/
git commit -m "chore: smoke test complete — card picking redesign done"
```
