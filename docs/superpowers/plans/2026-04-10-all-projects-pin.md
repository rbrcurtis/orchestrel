# All Projects Pin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "All Projects" option to the pinned column selector that cycles cards from every project using the same priority logic as per-project pins.

**Architecture:** Widen the `SlotState` pinned type's `projectId` from `number` to `number | 'all'`. The resolver gains a second pass after the per-project loop that handles `'all'` slots — collecting eligible cards from all projects (minus those already claimed), ranked with the same review → active running → queued running priority. The `ProjectPinSelector` gets an "All Projects" button with a rainbow gradient dot. Type changes cascade through `useSlots`, `board.tsx`, and `ProjectPinSelector`.

**Tech Stack:** TypeScript, React, Vitest, Tailwind CSS

---

### Task 1: Widen `SlotState` type and update `resolvePinnedCards`

**Files:**

- Modify: `app/lib/resolve-pin.ts:1-114`
- Test: `app/lib/resolve-pin.test.ts`

#### 1a: Add type alias and update SlotState

- [ ] **Step 1: Add `PinTarget` type alias and update `SlotState`**

In `app/lib/resolve-pin.ts`, change lines 1-6 from:

```typescript
import type { Card } from '../../src/shared/ws-protocol';

export type SlotState =
  { type: 'pinned'; projectId: number; cardId?: number } | { type: 'manual'; cardId: number } | { type: 'empty' };
```

to:

```typescript
import type { Card } from '../../src/shared/ws-protocol';

export type PinTarget = number | 'all';

export type SlotState =
  { type: 'pinned'; projectId: PinTarget; cardId?: number } | { type: 'manual'; cardId: number } | { type: 'empty' };
```

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `npx vitest run app/lib/resolve-pin.test.ts --reporter=verbose`
Expected: All 26 tests PASS (the type widening is backwards-compatible — all existing tests use `number` values).

#### 1b: Add "all" resolution pass to `resolvePinnedCards`

- [ ] **Step 3: Write failing tests for "all" pin resolution**

Add the following tests at the end of the `describe('resolvePinnedCards', ...)` block in `app/lib/resolve-pin.test.ts`:

```typescript
// ─── "all" pin resolution ──────────────────────────────────────────────────

it('resolves cards from any project into an "all" pinned slot', () => {
  const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 'all' }];
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

it('uses same priority ranking in "all" slots: review > active running > queued', () => {
  const slots: SlotState[] = [
    { type: 'empty' },
    { type: 'pinned', projectId: 'all' },
    { type: 'pinned', projectId: 'all' },
    { type: 'pinned', projectId: 'all' },
  ];
  const cards = [
    makeCard({ id: 1, projectId: 10, column: 'running', queuePosition: 1 }),
    makeCard({ id: 2, projectId: 20, column: 'running', queuePosition: null, updatedAt: '2026-03-20T02:00:00Z' }),
    makeCard({ id: 3, projectId: 30, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
  ];
  const result = resolvePinnedCards(slots, cards);
  expect(result.get(1)).toBe(3); // review first
  expect(result.get(2)).toBe(2); // active running second
  expect(result.get(3)).toBe(1); // queued running last
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

it('releases running cards in "all" slots when review cards are available', () => {
  const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 'all' }];
  const cards = [
    makeCard({ id: 1, projectId: 10, column: 'review', createdAt: '2026-03-20T01:00:00Z' }),
    makeCard({ id: 2, projectId: 20, column: 'running', queuePosition: null, updatedAt: '2026-03-20T02:00:00Z' }),
  ];
  const prev = new Map([[1, 2]]); // slot 1 was showing running card 2
  const result = resolvePinnedCards(slots, cards, prev);
  expect(result.get(1)).toBe(1); // review card takes priority, running released
});

it('returns empty for "all" slot when no eligible cards exist', () => {
  const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 'all' }];
  const cards = [makeCard({ id: 1, projectId: 10, column: 'backlog' })];
  const result = resolvePinnedCards(slots, cards);
  expect(result.has(1)).toBe(false);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run app/lib/resolve-pin.test.ts --reporter=verbose`
Expected: The 8 new "all" tests FAIL (the resolver currently skips `'all'` slots because `projectSlots` groups by numeric projectId and the filter checks `c.projectId === projectId`).

- [ ] **Step 5: Implement "all" resolution in `resolvePinnedCards`**

Replace the entire `resolvePinnedCards` function body in `app/lib/resolve-pin.ts` (lines 25-114) with:

```typescript
export function resolvePinnedCards(
  slots: SlotState[],
  cards: Card[],
  currentDisplayed: Map<number, number> = new Map(),
): Map<number, number> {
  // Build exclusion set: cards already stored in any slot
  const usedCardIds = new Set<number>();
  for (const slot of slots) {
    if (slot.type === 'manual') usedCardIds.add(slot.cardId);
    else if (slot.type === 'pinned' && slot.cardId != null) usedCardIds.add(slot.cardId);
  }

  // Index cards by id for fast lookup
  const cardById = new Map<number, Card>();
  for (const c of cards) cardById.set(c.id, c);

  // Group pinned slot indices by projectId (number keys) and collect "all" slots separately
  const projectSlots = new Map<number, number[]>();
  const allSlotIndices: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.type !== 'pinned') continue;
    if (slot.projectId === 'all') {
      allSlotIndices.push(i);
      continue;
    }
    const existing = projectSlots.get(slot.projectId);
    if (existing) existing.push(i);
    else projectSlots.set(slot.projectId, [i]);
  }

  const result = new Map<number, number>();

  // --- Per-project resolution (unchanged logic) ---
  for (const [projectId, slotIndices] of projectSlots) {
    const eligible = cards.filter(
      (c) => c.projectId === projectId && (c.column === 'review' || c.column === 'running') && !usedCardIds.has(c.id),
    );

    const hasReviewCards = eligible.some((c) => c.column === 'review');
    const stickyCardIds = new Set<number>();
    const unfilledSlots: number[] = [];
    for (const idx of slotIndices) {
      const prevCardId = currentDisplayed.get(idx);
      if (prevCardId != null) {
        const card = cardById.get(prevCardId);
        if (
          card &&
          card.projectId === projectId &&
          (card.column === 'review' || card.column === 'running') &&
          !usedCardIds.has(card.id)
        ) {
          if (card.column === 'running' && hasReviewCards) {
            unfilledSlots.push(idx);
            continue;
          }
          result.set(idx, prevCardId);
          stickyCardIds.add(prevCardId);
          continue;
        }
      }
      unfilledSlots.push(idx);
    }

    const ranked = rankCards(eligible.filter((c) => !stickyCardIds.has(c.id)));

    for (let i = 0; i < unfilledSlots.length; i++) {
      if (i < ranked.length) result.set(unfilledSlots[i], ranked[i].id);
    }
  }

  // --- "All" slots: collect cards not already claimed ---
  if (allSlotIndices.length > 0) {
    const claimedByProjectPins = new Set(result.values());
    const eligible = cards.filter(
      (c) =>
        c.projectId != null &&
        (c.column === 'review' || c.column === 'running') &&
        !usedCardIds.has(c.id) &&
        !claimedByProjectPins.has(c.id),
    );

    const hasReviewCards = eligible.some((c) => c.column === 'review');
    const stickyCardIds = new Set<number>();
    const unfilledSlots: number[] = [];
    for (const idx of allSlotIndices) {
      const prevCardId = currentDisplayed.get(idx);
      if (prevCardId != null) {
        const card = cardById.get(prevCardId);
        if (
          card &&
          (card.column === 'review' || card.column === 'running') &&
          !usedCardIds.has(card.id) &&
          !claimedByProjectPins.has(card.id)
        ) {
          if (card.column === 'running' && hasReviewCards) {
            unfilledSlots.push(idx);
            continue;
          }
          result.set(idx, prevCardId);
          stickyCardIds.add(prevCardId);
          continue;
        }
      }
      unfilledSlots.push(idx);
    }

    const ranked = rankCards(eligible.filter((c) => !stickyCardIds.has(c.id)));

    for (let i = 0; i < unfilledSlots.length; i++) {
      if (i < ranked.length) result.set(unfilledSlots[i], ranked[i].id);
    }
  }

  return result;
}
```

And add the `rankCards` helper above the function (after the types, before `resolvePinnedCards`):

```typescript
/** Rank eligible cards: review (oldest first) → active running (newest first) → queued running (queuePosition asc). */
function rankCards(eligible: Card[]): Card[] {
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

  return [...review, ...activeRunning, ...queuedRunning];
}
```

- [ ] **Step 6: Run all resolver tests**

Run: `npx vitest run app/lib/resolve-pin.test.ts --reporter=verbose`
Expected: All 34 tests PASS (26 existing + 8 new).

- [ ] **Step 7: Commit**

```bash
git add app/lib/resolve-pin.ts app/lib/resolve-pin.test.ts
git commit -m "feat: add 'all' pin target to resolve cards across all projects"
```

---

### Task 2: Update `useSlots` to accept `PinTarget`

**Files:**

- Modify: `app/lib/use-slots.ts:155-159`
- Test: `app/lib/use-slots.test.ts`

- [ ] **Step 1: Write failing tests for `applyPinSlot` with `'all'`**

Add to the `describe('applyPinSlot', ...)` block in `app/lib/use-slots.test.ts`:

```typescript
it('pins a slot to "all" projects', () => {
  const slots: SlotState[] = [{ type: 'empty' }, { type: 'empty' }];
  expect(applyPinSlot(slots, 1, 'all')[1]).toEqual({ type: 'pinned', projectId: 'all' });
});
```

And add to the `describe('applyOnCardCreated', ...)` block:

```typescript
it('places card in slot 0 when only an "all" pin exists (not project-specific)', () => {
  const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 'all' }];
  const { slots: next, flashIndex } = applyOnCardCreated(slots, 1, 10);
  expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
  expect(flashIndex).toBe(0);
});
```

And add to the `describe('applyDropCard', ...)` block:

```typescript
it('converts to manual when dropping onto an "all" pinned slot', () => {
  const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 'all' }];
  const { slots: next } = applyDropCard(slots, 1, 5, 10);
  // "all" pin has no specific projectId to match, so becomes manual
  expect(next[1]).toEqual({ type: 'manual', cardId: 5 });
});
```

And add to the `describe('applySelectCard', ...)` block:

```typescript
it('does not treat "all" pinned slot as project-specific for override placement', () => {
  const slots: SlotState[] = [{ type: 'empty' }, { type: 'pinned', projectId: 'all' }];
  const cards = [makeCard({ id: 1, projectId: 10, column: 'done' })];
  const resolved = new Map<number, number>();
  // "all" slots don't match a specific projectId, so card goes to slot 0 fallback
  const { slots: next, flashIndex } = applySelectCard(slots, 1, cards, resolved);
  expect(next[0]).toEqual({ type: 'manual', cardId: 1 });
  expect(flashIndex).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/use-slots.test.ts --reporter=verbose`
Expected: The new tests FAIL because `applyPinSlot` signature only accepts `number`.

- [ ] **Step 3: Widen `applyPinSlot` and `UseSlotsResult.pinSlot` to accept `PinTarget`**

In `app/lib/use-slots.ts`, add the import of `PinTarget`:

Change line 2 from:

```typescript
import { resolvePinnedCards, type SlotState } from './resolve-pin';
```

to:

```typescript
import { resolvePinnedCards, type SlotState, type PinTarget } from './resolve-pin';
```

Change `applyPinSlot` (line 155) from:

```typescript
export function applyPinSlot(slots: SlotState[], index: number, projectId: number): SlotState[] {
```

to:

```typescript
export function applyPinSlot(slots: SlotState[], index: number, projectId: PinTarget): SlotState[] {
```

Change the `UseSlotsResult` type (line 224) from:

```typescript
  pinSlot: (index: number, projectId: number) => void;
```

to:

```typescript
  pinSlot: (index: number, projectId: PinTarget) => void;
```

Change the `pinSlot` function inside `useSlots` (line 287) from:

```typescript
  function pinSlot(index: number, projectId: number) {
```

to:

```typescript
  function pinSlot(index: number, projectId: PinTarget) {
```

- [ ] **Step 4: Run all slot tests**

Run: `npx vitest run app/lib/use-slots.test.ts --reporter=verbose`
Expected: All tests PASS (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add app/lib/use-slots.ts app/lib/use-slots.test.ts
git commit -m "feat: widen pinSlot to accept PinTarget ('all' | number)"
```

---

### Task 3: Add "All Projects" option to `ProjectPinSelector`

**Files:**

- Modify: `app/components/ProjectPinSelector.tsx`

- [ ] **Step 1: Widen `onSelect` prop to accept `PinTarget` and add "All Projects" button**

Replace the entire content of `app/components/ProjectPinSelector.tsx` with:

```typescript
import { observer } from 'mobx-react-lite';
import { useProjectStore } from '~/stores/context';
import type { PinTarget } from '~/lib/resolve-pin';

type Props = {
  onSelect: (projectId: PinTarget) => void;
};

export const ProjectPinSelector = observer(function ProjectPinSelector({ onSelect }: Props) {
  const projectStore = useProjectStore();
  const projects = projectStore.all;

  if (projects.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No projects configured
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="flex flex-col gap-1 w-full max-w-48">
        <span className="text-xs text-muted-foreground font-medium px-3 mb-1">Pin to project</span>
        <button
          className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent text-sm text-left transition-colors"
          onClick={() => onSelect('all')}
        >
          <span
            className="size-2.5 rounded-full shrink-0"
            style={{
              background: 'conic-gradient(from 0deg, #ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444)',
            }}
          />
          <span className="truncate">All Projects</span>
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent text-sm text-left transition-colors"
            onClick={() => onSelect(p.id)}
          >
            {p.color && <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: p.color }} />}
            <span className="truncate">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Verify the app compiles**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: No type errors (if any appear, they'll be in board.tsx — addressed in the next task).

- [ ] **Step 3: Commit**

```bash
git add app/components/ProjectPinSelector.tsx
git commit -m "feat: add 'All Projects' option with rainbow dot to pin selector"
```

---

### Task 4: Update `board.tsx` to handle `'all'` pin in column slots

**Files:**

- Modify: `app/routes/board.tsx:398-615`

- [ ] **Step 1: Widen `onPin` prop and update header rendering for "all" pins**

In `app/routes/board.tsx`, change the `ColumnSlotProps` type's `onPin` (around line 449):

From:

```typescript
  onPin: (projectId: number) => void;
```

To:

```typescript
  onPin: (projectId: PinTarget) => void;
```

Add the `PinTarget` import at the top of the file. Find the existing import from `~/lib/resolve-pin` (or wherever `SlotState` is imported from) and add `PinTarget`:

```typescript
import type { SlotState, PinTarget } from '~/lib/resolve-pin';
```

- [ ] **Step 2: Update `pinProjectId` variable type and border color for "all" pins**

In the `columnSlots.map` block (around line 400), change:

```typescript
const pinProjectId = slot.type === 'pinned' ? slot.projectId : null;
```

This already returns `PinTarget | null` after the type change, so no code change needed — but the `pinProject` lookup and `borderColor` need updating. Change (around lines 409-410):

From:

```typescript
const pinProject = pinProjectId != null ? projectStore.getProject(pinProjectId) : null;
const borderColor = pinProject?.color ?? slotProject?.color ?? null;
```

To:

```typescript
const pinProject = typeof pinProjectId === 'number' ? projectStore.getProject(pinProjectId) : null;
const borderColor = pinProjectId === 'all' ? null : (pinProject?.color ?? slotProject?.color ?? null);
```

- [ ] **Step 3: Update `ColumnSlotProps` type for `pinProjectId`**

Change (around line 448):

```typescript
pinProjectId: number | null;
```

To:

```typescript
pinProjectId: PinTarget | null;
```

- [ ] **Step 4: Update the empty pinned slot rendering to handle "all"**

In the `ColumnSlot` component, the empty pinned state (around line 577) renders the project badge and the `+` button. Replace the entire empty-pinned branch (`pinProjectId != null ? (` ... closing `</div>`) with:

From:

```typescript
        ) : pinProjectId != null ? (
          <div className="flex flex-col flex-1">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => setCreatingCard(true)}>
                <Plus className="size-4" />
              </Button>
              <span className="flex-1" />
              {(() => {
                const p = projectStore.getProject(pinProjectId);
                return p ? (
                  <Badge
                    variant="secondary"
                    className={`text-xs shrink-0 ${p.color ? 'animate-review-glow' : ''}`}
                    style={{
                      ...(p.color ? { borderLeft: `3px solid ${p.color}` } : {}),
                      ...(p.color ? ({ '--glow-color': p.color } as React.CSSProperties) : {}),
                    }}
                  >
                    {p.name}
                  </Badge>
                ) : null;
              })()}
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => unpinSlot(index)}>
                <X className="size-4" />
              </Button>
            </div>
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              No review or running cards
            </div>
          </div>
```

To:

```typescript
        ) : pinProjectId != null ? (
          <div className="flex flex-col flex-1">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
              {typeof pinProjectId === 'number' && (
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => setCreatingCard(true)}>
                  <Plus className="size-4" />
                </Button>
              )}
              <span className="flex-1" />
              {pinProjectId === 'all' ? (
                <Badge variant="secondary" className="text-xs shrink-0">
                  <span
                    className="inline-block size-2 rounded-full mr-1.5"
                    style={{
                      background: 'conic-gradient(from 0deg, #ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444)',
                    }}
                  />
                  All Projects
                </Badge>
              ) : (() => {
                const p = projectStore.getProject(pinProjectId);
                return p ? (
                  <Badge
                    variant="secondary"
                    className={`text-xs shrink-0 ${p.color ? 'animate-review-glow' : ''}`}
                    style={{
                      ...(p.color ? { borderLeft: `3px solid ${p.color}` } : {}),
                      ...(p.color ? ({ '--glow-color': p.color } as React.CSSProperties) : {}),
                    }}
                  >
                    {p.name}
                  </Badge>
                ) : null;
              })()}
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => unpinSlot(index)}>
                <X className="size-4" />
              </Button>
            </div>
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              No review or running cards
            </div>
          </div>
```

- [ ] **Step 5: Update the `creatingCard` branch to skip for "all" pins**

The `creatingCard && pinProjectId != null` branch (around line 554) passes `pinProjectId` as `initialProjectId` to `NewCardDetail`. Since `'all'` has no single project, guard it. Change:

From:

```typescript
        ) : creatingCard && pinProjectId != null ? (
          <NewCardDetail
            column="running"
            initialProjectId={pinProjectId}
```

To:

```typescript
        ) : creatingCard && typeof pinProjectId === 'number' ? (
          <NewCardDetail
            column="running"
            initialProjectId={pinProjectId}
```

- [ ] **Step 6: Update the `onClose` handler for CardDetail to handle "all" pins**

The `onClose` for `CardDetail` (around line 572) checks `pinProjectId != null`. This works correctly already because `'all'` is truthy — closing a card in an "all" slot should unpin it. However, `pinned` prop also uses `pinProjectId != null` which is correct. No change needed here.

- [ ] **Step 7: Verify the app compiles and renders**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: No type errors.

Then verify visually by opening the dev server and checking that empty "all" pinned slots show the "All Projects" badge with the rainbow dot and no `+` button.

- [ ] **Step 8: Commit**

```bash
git add app/routes/board.tsx
git commit -m "feat: render 'All Projects' badge with rainbow dot in pinned column slots"
```

---

### Task 5: Handle `'all'` pin edge cases in `applyDropCard` and `applySelectCard`

**Files:**

- Modify: `app/lib/use-slots.ts:106-135` (applyDropCard)

The `applyDropCard` function (line 128) checks `cardProjectId === target.projectId` to decide whether to preserve the pin. For `'all'` slots, no single card project matches `'all'`, so it correctly falls through to `manual`. The `applySelectCard` function (line 89) checks `slot.projectId === projectId` — for `'all'`, no card's numeric projectId will match `'all'`, so it correctly skips. Both behaviors are correct by default and covered by the tests from Task 2.

- [ ] **Step 1: Run full test suite to verify everything works end-to-end**

Run: `npx vitest run app/lib/ --reporter=verbose`
Expected: All tests in both `resolve-pin.test.ts` and `use-slots.test.ts` PASS.

- [ ] **Step 2: Final commit (if any remaining changes)**

If no changes needed, skip this step.

---

### Task 6: Border color for "all" pin when card is displayed

**Files:**

- Modify: `app/routes/board.tsx:410`

When an "all" slot is displaying a card, the border divider should show that card's project color (not the pin's color, since "all" has no color).

- [ ] **Step 1: Verify border color logic**

The current code after Task 4 step 2:

```typescript
const borderColor = pinProjectId === 'all' ? null : (pinProject?.color ?? slotProject?.color ?? null);
```

When `pinProjectId === 'all'`, `borderColor` is `null`, but `slotProject?.color` (the displayed card's project color) is available. Change to:

```typescript
const borderColor =
  pinProjectId === 'all' ? (slotProject?.color ?? null) : (pinProject?.color ?? slotProject?.color ?? null);
```

This makes "all" slots use the displayed card's project color as their border, which provides useful visual context about which project the current card belongs to.

- [ ] **Step 2: Commit**

```bash
git add app/routes/board.tsx
git commit -m "feat: use displayed card's project color as border for 'all' pinned slots"
```
