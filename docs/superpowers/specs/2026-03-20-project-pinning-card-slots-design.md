# Project Pinning Card Slots

Pin a column slot to a project so it automatically displays the highest-priority card for that project. Cards rotate in and out as their statuses change — no manual slot management needed for projects you're actively monitoring.

## Context

Column slots are a client-side concept (persisted in localStorage) that let users open card detail views side by side. Currently, every slot is manually managed — you click or drag a card to open it, and close it with the X button. For projects with frequent card turnover (cards moving through review and running), this requires constant manual slot juggling.

## Design

### Data Model

A new `columnPins` array sits alongside the existing `columnSlots` array:

```
columnSlots: (number | null)[]   // card IDs (existing)
columnPins:  (number | null)[]   // project IDs (new)
```

- `columnPins[i] = projectId` — slot `i` is pinned to that project
- `columnPins[i] = null` — normal slot, no pin
- Persisted to localStorage key `dispatcher-column-pins`
- Array kept in sync with `columnCount` using the same resize logic as `columnSlots` (grow fills with `null`, shrink truncates)

**Slot 0 is the hotseat.** It is where `selectCard` falls back to and where new cards are created. `columnPins[0]` is always `null` — slot 0 cannot be pinned.

### Card Resolution Logic

A MobX computed resolves which card to display in each pinned slot.

**Priority order per project:**

1. **Review cards** — `projectId === pin` AND `column === 'review'` — sorted by `createdAt` ASC (oldest first)
2. **Running cards** — `projectId === pin` AND `column === 'running'` — sorted by `updatedAt` DESC (most recently active first)
3. **Empty** — no qualifying cards, `columnSlots[i] = null`

Review and running cards are concatenated into a single ranked list per project.

**Multiple slots pinned to the same project:**

Resolution is coordinated across all pinned slots for a given project. The ranked list of qualifying cards is distributed across slots in slot-index order:

- Lowest-index pinned slot gets rank 1 card
- Next pinned slot gets rank 2 card
- And so on

This prevents two slots from showing the same card and allows busy projects to have multiple monitoring slots.

**Reactivity:**

The resolver reads from the MobX `cardStore.cards` observable map. Any card insert, update, or delete that changes `column`, `projectId`, or `updatedAt` triggers automatic recomputation. No manual event wiring needed.

### Pin Lifecycle

**Setting a pin:**

- Empty unpinned slots (1+) show a project selector
- Selecting a project sets `columnPins[i] = projectId`
- Resolution runs immediately, populating or leaving the slot empty

**Clearing a pin (three ways):**

1. **Close button (X)** — clears pin (`columnPins[i] = null`), clears card (`columnSlots[i] = null`). Slot becomes normal empty.
2. **Drag card into pinned slot** — clears pin, sets dragged card. Slot becomes a normal manually-managed slot.
3. Slot removal via the `-` button (truncates from right, pin is lost if the rightmost slot was pinned).

**`selectCard` behavior:**

`selectCard` skips any slot where `columnPins[i]` is set, regardless of whether a card is currently showing. Pinned slots are reserved — only the resolver or explicit drag can place cards there. Slot 0 remains the fallback.

### Visual Treatment

**Header visibility rule:**

Show the slot header if `columnSlots[i] !== null` OR `columnPins[i] !== null`. Hide it (show empty placeholder) only when the slot is unpinned AND empty.

This makes headers more persistent than they are today — a pinned-but-empty slot still shows its header with the project name/color and the X button.

**Pinned slot header:**

- Project name and project neon color
- X button to close/unpin
- When a card is resolved: normal card detail view below
- When no card qualifies: content area shows a subtle "No review or running cards" message

**Left border color:**

For pinned slots, always use the pinned project's color, even when empty. (Currently the border color comes from whatever card is showing.)

**Flash animation on auto-swap:**

When the resolver changes which card is in a slot (previous card ID !== new card ID), trigger the existing flash animation. This is the same animation that fires when clicking a card already open in a slot — it signals the transition visually.

**Slot 0 (hotseat):**

No changes. No pin UI. Behaves exactly as it does today.

**Empty unpinned slots (1+):**

Show the project selector to set a pin. Also still accept drag-drop of cards (existing behavior).

### Architecture

**No server changes.** The entire feature lives client-side:

- `columnPins` state and localStorage persistence (same pattern as `columnSlots`)
- Resolution logic is a MobX computed in `board.tsx`
- Flash animation triggered by watching resolved card IDs

**Event-driven fit:**

The resolver is purely reactive. It reads current state from the card store (updated by `card:updated` WS events) and computes the answer. It doesn't care why a card changed — it reacts to current state. The chain is: card status changes on server → `board:changed` event → WS pushes `card:updated` → MobX store updates → computed recomputes → slot reflects new card → flash fires if card changed.

No new WS events, no new DB columns, no new server handlers.

### Implementation Scope

1. Add `columnPins` state + localStorage persistence alongside existing slot state
2. Resolver function: `resolvePin(projectId, excludeCardIds) → cardId | null`
3. Coordination layer: for each unique project in pins, resolve ranked list, distribute across slots
4. Wire resolver output into `columnSlots` updates (with flash trigger on change)
5. Guard `selectCard` to skip pinned slots
6. Guard slot 0 from pinning
7. Update `ColumnSlot` component: header visibility rule, project selector for empty unpinned slots 1+, pinned-but-empty state
8. Update drag-drop handler: dropping into a pinned slot clears the pin
