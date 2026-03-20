# Project Pinning Card Slots Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin column slots to projects so they automatically display the highest-priority review or running card, with flash animation on auto-swap.

**Architecture:** Purely client-side. A `columnPins` array (localStorage) tracks which slots are pinned to which projects. A MobX resolver function computes which card each pinned slot should show by filtering the card store. The resolver coordinates across multiple slots pinned to the same project to avoid duplicates. No server changes.

**Tech Stack:** React, MobX, localStorage, existing flash animation CSS

---

## File Structure

| File                                    | Action | Responsibility                                                                                               |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `app/routes/board.tsx`                  | Modify | Add `columnPins` state, sync logic, resolver, update `selectCard`/`closeSlot`/`ColumnSlot`, update drag-drop |
| `app/lib/resolve-pin.ts`                | Create | Pure function: given cards, project pins, and excluded IDs, returns resolved card IDs                        |
| `app/lib/resolve-pin.test.ts`           | Create | Unit tests for the resolver                                                                                  |
| `app/components/ProjectPinSelector.tsx` | Create | Project picker component for empty unpinned slots                                                            |

---

## Chunk 1: Pin Resolver Logic

### Task 1: Write the pin resolver function with tests

The resolver is a pure function — no MobX, no React, no side effects. Takes cards + pin config, returns resolved card IDs.

**Files:**

- Create: `app/lib/resolve-pin.ts`
- Create: `app/lib/resolve-pin.test.ts`

- [ ] **Step 1: Write failing tests for basic resolution**

```ts
// app/lib/resolve-pin.test.ts
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
    // slot 0 = null (hotseat), slots 1 and 2 pinned to project 10
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/resolve-pin.test.ts`
Expected: FAIL — module `./resolve-pin` not found

- [ ] **Step 3: Implement the resolver**

```ts
// app/lib/resolve-pin.ts
import type { Card } from '../../src/shared/ws-protocol';

/**
 * Resolve which card each pinned slot should display.
 *
 * Priority per project:
 *   1. Review cards — oldest createdAt first
 *   2. Running cards — newest updatedAt first
 *
 * Multiple slots pinned to the same project get distributed
 * across the ranked list (lower slot index = higher priority card).
 *
 * Slot 0 is never pinned (hotseat) — pins[0] should always be null.
 *
 * @param cards - All cards from the card store
 * @param pins - columnPins array: projectId or null per slot
 * @returns Array of cardId or null, same length as pins
 */
export function resolvePins(cards: Card[], pins: (number | null)[]): (number | null)[] {
  // Group pinned slot indices by projectId
  const projectSlots = new Map<number, number[]>();
  for (let i = 0; i < pins.length; i++) {
    const pid = pins[i];
    if (pid == null) continue;
    const slots = projectSlots.get(pid);
    if (slots) slots.push(i);
    else projectSlots.set(pid, [i]);
  }

  const result: (number | null)[] = pins.map(() => null);

  for (const [projectId, slotIndices] of projectSlots) {
    // Build ranked card list for this project
    const review = cards
      .filter((c) => c.projectId === projectId && c.column === 'review')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const running = cards
      .filter((c) => c.projectId === projectId && c.column === 'running')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const ranked = [...review, ...running];

    // Distribute across slots in slot-index order
    for (let i = 0; i < slotIndices.length; i++) {
      result[slotIndices[i]] = i < ranked.length ? ranked[i].id : null;
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/resolve-pin.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add app/lib/resolve-pin.ts app/lib/resolve-pin.test.ts
git commit -m "feat: add pin resolver function with tests"
```

---

## Chunk 2: Column Pins State & Wiring in board.tsx

### Task 2: Add columnPins state with localStorage persistence

**Files:**

- Modify: `app/routes/board.tsx:24-25` (add localStorage key)
- Modify: `app/routes/board.tsx:97-101` (add state)
- Modify: `app/routes/board.tsx:106-118` (sync pins array length)

- [ ] **Step 1: Add the localStorage key constant**

In `app/routes/board.tsx`, after line 24 (`COLUMN_SLOTS_KEY`), add:

```ts
const COLUMN_PINS_KEY = 'dispatcher-column-pins';
```

- [ ] **Step 2: Add columnPins state**

After line 99 (`columnSlots` state), add:

```ts
const [columnPins, setColumnPins] = useState<(number | null)[]>(() => readLocalStorage(COLUMN_PINS_KEY, [null]));
```

- [ ] **Step 3: Add updatePins helper (mirrors updateSlots)**

After the `updateSlots` callback (line 129-135), add:

```ts
const updatePins = useCallback((updater: (prev: (number | null)[]) => (number | null)[]) => {
  setColumnPins((prev) => {
    const next = updater(prev);
    writeLocalStorage(COLUMN_PINS_KEY, next);
    return next;
  });
}, []);
```

- [ ] **Step 4: Sync columnPins length with columnCount**

In the existing `useEffect` that syncs `columnSlots` length (lines 106-118), add a parallel sync for `columnPins` right after. Add a new `useEffect`:

```ts
// Keep columnPins length in sync with columnCount
useEffect(() => {
  setColumnPins((prev) => {
    if (prev.length === columnCount) return prev;
    if (prev.length < columnCount) {
      const next = [...prev, ...(Array(columnCount - prev.length).fill(null) as null[])];
      writeLocalStorage(COLUMN_PINS_KEY, next);
      return next;
    }
    const next = prev.slice(0, columnCount);
    writeLocalStorage(COLUMN_PINS_KEY, next);
    return next;
  });
}, [columnCount]);
```

- [ ] **Step 5: Verify the app compiles and loads**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add app/routes/board.tsx
git commit -m "feat: add columnPins state with localStorage persistence"
```

### Task 3: Wire the resolver into board.tsx

Connect `resolvePins` to the MobX card store so pinned slots auto-update.

**Files:**

- Modify: `app/routes/board.tsx` (add import, add resolver effect, update slots from resolver)

- [ ] **Step 1: Import resolvePins**

Add to imports at top of `board.tsx`:

```ts
import { resolvePins } from '~/lib/resolve-pin';
```

- [ ] **Step 2: Add resolver reaction**

After the eviction `useEffect` (lines 138-152), add a MobX `reaction` that runs the resolver whenever cards or pins change. Using `reaction` instead of `useEffect` ensures proper MobX tracking — `useEffect` callbacks aren't tracked by MobX's observer wrapper. Import `reaction` from `mobx`:

```ts
import { reaction } from 'mobx';
```

Then add the reaction inside `BoardLayout`:

```ts
// Resolve pinned slots — MobX reaction tracks card store changes
useEffect(() => {
  const dispose = reaction(
    () => {
      // Data expression: read all MobX observables we depend on
      const allCards = Array.from(cardStore.cards.values());
      return { allCards, pins: columnPins };
    },
    ({ allCards, pins }) => {
      const hasPins = pins.some((p) => p != null);
      if (!hasPins) return;

      const resolved = resolvePins(allCards, pins);

      updateSlots((prev) => {
        let changed = false;
        const next = [...prev];
        for (let i = 0; i < next.length; i++) {
          if (pins[i] == null) continue; // not pinned, leave alone
          if (next[i] !== resolved[i]) {
            if (resolved[i] != null) {
              setFlashSlot(i);
            }
            next[i] = resolved[i];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    { fireImmediately: true },
  );
  return dispose;
}, [columnPins]); // re-subscribe when pins change
```

Note: `columnPins` is React state (not MobX), so it goes in the deps array. Card store changes are tracked by MobX's `reaction` data expression.

- [ ] **Step 3: Verify the app compiles**

Run: `npx tsc --noEmit`
Expected: No type errors. Note: `reaction` must be imported from `'mobx'`.

- [ ] **Step 4: Commit**

```bash
git add app/routes/board.tsx
git commit -m "feat: wire pin resolver into board layout"
```

### Task 4: Update selectCard to skip pinned slots

**Files:**

- Modify: `app/routes/board.tsx:161-186` (selectCard function)

- [ ] **Step 1: Modify selectCard to skip pinned slots**

Replace the desktop path of `selectCard` (lines 172-185) with:

```ts
if (id === null) return;
// Desktop: place in next open slot, or slot 0 if all full
// Skip pinned slots — they're reserved for the resolver
updateSlots((prev) => {
  const existingIdx = prev.indexOf(id);
  if (existingIdx >= 0) {
    // Already open — flash that slot
    setFlashSlot(existingIdx);
    return prev;
  }
  const next = [...prev];
  const emptyIdx = next.findIndex((slot, i) => slot === null && columnPins[i] == null);
  next[emptyIdx >= 0 ? emptyIdx : 0] = id;
  return next;
});
```

The key change: `next.indexOf(null)` becomes `next.findIndex((slot, i) => slot === null && columnPins[i] == null)` — skips pinned-but-empty slots.

- [ ] **Step 2: Verify the app compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add app/routes/board.tsx
git commit -m "feat: selectCard skips pinned slots"
```

### Task 5: Update closeSlot to clear pins

**Files:**

- Modify: `app/routes/board.tsx:188-194` (closeSlot function)

- [ ] **Step 1: Modify closeSlot to also clear the pin**

Replace `closeSlot` with:

```ts
function closeSlot(index: number) {
  updateSlots((prev) => {
    const next = [...prev];
    next[index] = null;
    return next;
  });
  updatePins((prev) => {
    if (prev[index] == null) return prev;
    const next = [...prev];
    next[index] = null;
    return next;
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add app/routes/board.tsx
git commit -m "feat: closeSlot clears pin"
```

### Task 6: Update drag-drop to clear pins

**Files:**

- Modify: `app/routes/board.tsx:505-537` (ColumnSlot handleDrop)

- [ ] **Step 1: Pass updatePins to ColumnSlot**

Add `updatePins` to `ColumnSlotProps` type and to the JSX where `ColumnSlot` is rendered (around line 440):

In the props type (line 463-473), add:

```ts
updatePins: (updater: (prev: (number | null)[]) => (number | null)[]) => void;
```

In the JSX (around line 440), add the prop:

```tsx
updatePins = { updatePins };
```

Also pass `pinProjectId` so ColumnSlot knows if it's pinned:

```ts
// Add to ColumnSlotProps:
pinProjectId: number | null;

// In JSX:
pinProjectId={columnPins[idx] ?? null}
```

- [ ] **Step 2: Clear pin on drop in ColumnSlot handleDrop**

In the `handleDrop` function, after each branch that updates slots, also clear the pin for the target slot. At the end of both the column-to-column drag block and the kanban card drag block, add:

```ts
updatePins((prev) => {
  if (prev[index] == null) return prev;
  const next = [...prev];
  next[index] = null;
  return next;
});
```

- [ ] **Step 3: Also clear pin on column-to-column swap (source slot)**

In the column-to-column header drag handler (lines 510-521), the source slot becomes empty. If the source was pinned, the pin should also be cleared since the user is manually rearranging:

```ts
updatePins((prev) => {
  if (prev[srcIdx] == null && prev[index] == null) return prev;
  const next = [...prev];
  next[srcIdx] = null;
  next[index] = null;
  return next;
});
```

- [ ] **Step 4: Verify the app compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add app/routes/board.tsx
git commit -m "feat: drag-drop clears pins on target slot"
```

---

## Chunk 3: UI Components

### Task 7: Create the ProjectPinSelector component

A simple project picker for empty unpinned slots (1+).

**Files:**

- Create: `app/components/ProjectPinSelector.tsx`

- [ ] **Step 1: Create the component**

```tsx
// app/components/ProjectPinSelector.tsx
import { observer } from 'mobx-react-lite';
import { useProjectStore } from '~/stores/context';

type Props = {
  onSelect: (projectId: number) => void;
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
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4">
      <span className="text-xs text-muted-foreground font-medium">Pin to project</span>
      <div className="flex flex-col gap-1 w-full max-w-48">
        {projects.map((p) => (
          <button
            key={p.id}
            className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent text-sm text-left transition-colors"
            onClick={() => onSelect(p.id)}
          >
            {p.color && (
              <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: `var(--${p.color})` }} />
            )}
            <span className="truncate">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add app/components/ProjectPinSelector.tsx
git commit -m "feat: add ProjectPinSelector component"
```

### Task 8: Update ColumnSlot to show pin states

The ColumnSlot component needs three visual states for non-hotseat slots:

1. **Pinned with card** — header + card detail (header shows project name, X closes and unpins)
2. **Pinned without card** — header + "No review or running cards" message
3. **Unpinned empty** — project selector (or "Select a card" if slot 0)

**Files:**

- Modify: `app/routes/board.tsx:463-591` (ColumnSlot component)

- [ ] **Step 1: Import ProjectPinSelector**

Add to imports:

```ts
import { ProjectPinSelector } from '~/components/ProjectPinSelector';
```

- [ ] **Step 2: Update ColumnSlotProps and destructuring**

The props type should already have `pinProjectId` and `updatePins` from Task 6. Also add a callback for setting pins:

```ts
// Add to ColumnSlotProps:
onPin: (projectId: number) => void;
```

In `BoardLayout`, define the callback and pass it:

```ts
function pinSlot(index: number, projectId: number) {
  updatePins((prev) => {
    const next = [...prev];
    next[index] = projectId;
    return next;
  });
}
```

In JSX:

```tsx
onPin={(projectId) => pinSlot(idx, projectId)}
```

- [ ] **Step 3: Add X import from lucide-react**

Check if `X` is already imported in `board.tsx`. If not, add it to the lucide-react import line:

```ts
import { Settings, Palette, Minus, Plus, Filter, X } from 'lucide-react';
```

- [ ] **Step 4: Add useProjectStore inside ColumnSlot**

`ColumnSlot` needs access to `projectStore` to display the project name in pinned-empty headers. Add at the top of the ColumnSlot function body:

```ts
const projectStore = useProjectStore();
```

- [ ] **Step 5: Update ColumnSlot border color for pinned slots**

In `BoardLayout` where `borderColor` is computed (lines 436-438), update to prefer pinned project color:

```ts
const pinProject = columnPins[idx] != null ? projectStore.getProject(columnPins[idx]!) : null;
const slotCard = cardId != null ? cardStore.getCard(cardId) : undefined;
const slotProject = slotCard?.projectId ? projectStore.getProject(slotCard.projectId) : null;
const borderColor = pinProject?.color ?? slotProject?.color ?? null;
```

- [ ] **Step 6: Update ColumnSlot content rendering**

Replace the content area of ColumnSlot (lines 565-587) with logic that handles pin states:

```tsx
{
  newCardColumn && index === 0 ? (
    <NewCardDetail
      column={newCardColumn}
      onCreated={(id) => {
        setDraftColor(null);
        setNewCardColumn(null);
        updateSlots((prev) => {
          const next = [...prev];
          next[0] = id;
          return next;
        });
      }}
      onClose={() => {
        setDraftColor(null);
        setNewCardColumn(null);
      }}
      onColorChange={setDraftColor}
    />
  ) : cardId != null ? (
    <CardDetail cardId={cardId} onClose={() => closeSlot(index)} slotIndex={index} />
  ) : pinProjectId != null ? (
    /* Pinned but no qualifying card */
    <div className="flex flex-col flex-1">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium text-muted-foreground truncate">
          {(() => {
            const p = projectStore.getProject(pinProjectId);
            return p?.name ?? 'Unknown project';
          })()}
        </span>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => closeSlot(index)}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No review or running cards
      </div>
    </div>
  ) : index === 0 ? (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Select a card</div>
  ) : (
    <ProjectPinSelector onSelect={(pid) => onPin(pid)} />
  );
}
```

- [ ] **Step 7: Update header visibility**

Currently the slot header is part of `CardDetail` (it renders its own header). For pinned-but-empty slots, we added a header inline in step 4. For pinned-with-card slots, the `CardDetail` header already shows. This should work as-is.

- [ ] **Step 8: Verify the app compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 9: Commit**

```bash
git add app/routes/board.tsx app/components/ProjectPinSelector.tsx
git commit -m "feat: ColumnSlot renders pin states with project selector"
```

### Task 9: Flash animation on auto-swap

The flash trigger is already wired in Task 3's resolver reaction — it calls `setFlashSlot(i)` whenever `resolved[i] != null` and the resolved card changes. This flashes on:

- Card swapping to a different card
- A card first appearing in a previously-empty pinned slot

It does NOT flash when a card disappears (slot going empty).

No additional code needed — this task is a verification checkpoint.

- [ ] **Step 1: Verify flash fires correctly during manual testing (Task 10)**

Confirm the existing flash animation CSS (`animate-slot-flash`) triggers when the resolver swaps a pinned slot's card. The ColumnSlot component already renders the flash overlay when `flash === true`.

---

## Chunk 4: Manual Testing & Polish

### Task 10: End-to-end manual verification

No automated E2E tests — verify manually in the browser.

- [ ] **Step 1: Start the dev server if not running**

The app runs at `http://localhost:6194`.

- [ ] **Step 2: Test pin lifecycle**

1. Add a second column slot (+ button)
2. Slot 1 should show the project selector (not "Select a card")
3. Click a project to pin it
4. If that project has review or running cards, the slot should populate immediately
5. If not, the slot should show "No review or running cards" with the project header

- [ ] **Step 3: Test auto-swap**

1. Pin a slot to a project with a review card
2. Move that card to `done` in the kanban
3. The slot should immediately show the next qualifying card (or go empty) with a flash

- [ ] **Step 4: Test drag-drop clears pin**

1. Pin a slot to a project
2. Drag a different card from the kanban into that slot
3. Pin should be cleared — slot now shows the dragged card as a normal slot

- [ ] **Step 5: Test selectCard skips pinned slots**

1. Pin slot 1 to a project
2. Click a card in the kanban
3. It should open in slot 0 (hotseat), not in the pinned slot

- [ ] **Step 6: Test close (X) clears pin**

1. Pin a slot to a project
2. Click X on the slot header
3. Pin and card should both clear — slot should show project selector again

- [ ] **Step 7: Test multiple slots same project**

1. Add 3 column slots
2. Pin slots 1 and 2 to the same project
3. They should show different cards (rank 1 and rank 2)
4. Move the rank 1 card to done — cards should shift

- [ ] **Step 8: Test slot 0 cannot be pinned**

1. With only 1 column, verify slot 0 shows "Select a card" (not the project selector)

- [ ] **Step 9: Commit any fixes from manual testing**

```bash
git add -A
git commit -m "fix: polish from manual testing"
```
