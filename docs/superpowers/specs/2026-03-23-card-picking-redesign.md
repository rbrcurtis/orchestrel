# Card Picking Logic Redesign — Design Spec

Date: 2026-03-23

## Background

The current card picking logic for pinned column slots uses two parallel arrays (`columnSlots`, `columnPins`) kept in sync by a MobX reaction wired inside a `useEffect`. This model stores derived state (what card a pinned slot shows) as mutable state that a reactor must keep correct. Bugs have accumulated from the split between MobX and React reactivity, incomplete drag handling paths, and an exclusion model that only covers manual slots. This redesign eliminates the class of bugs by making pinned slot card display purely computed.

## Requirements

See `docs/specs/card-picking-requirements.md` for the full requirements (R1–R12).

## Slot Type Model

Replace the two parallel arrays with a single `SlotState[]`:

```ts
type SlotState =
  | { type: 'pinned'; projectId: number; cardId?: number }
  | { type: 'manual'; cardId: number }
  | { type: 'empty' };
```

- **`pinned`** — auto-managed by the resolver. The optional `cardId` is an override: a card the user explicitly placed that the resolver wouldn't pick up on its own (e.g. a done card clicked into an empty pinned slot per R7). When the slot is closed, the override clears and the resolver takes back over. When the resolver has a qualifying card, the resolver result takes priority over the override.
- **`manual`** — user explicitly placed a card, no pin, shown as-is.
- **`empty`** — nothing here. Slot 0 shows "Select a card". Slots 1+ show the project picker.

Slot 0 can only be `manual` or `empty` — never `pinned`.

**Display logic per slot:**

- `manual`: show `cardId`
- `pinned` with a resolver result: show resolver result
- `pinned` with no resolver result but `cardId` override: show `cardId`
- `empty`: show nothing

**Persistence:** single localStorage key `dispatcher-slots` replaces the previous `dispatcher-column-slots` and `dispatcher-column-pins` keys.

## Resolver

A pure function called once per render inside the `observer()` component tree:

```ts
function resolvePinnedCards(slots: SlotState[], cards: Card[]): Map<number, number>;
```

Returns a `Map<slotIndex, cardId>` for every pinned slot that has a qualifying card. Slots with no qualifying card are absent from the map.

**Exclusion set** — cards already visible in any slot are ineligible:

- All `manual` slot `cardIds`
- All `pinned` slot `cardId` overrides

**Per-project pass:**

1. Collect all slot indices that are `pinned` to this project
2. Filter eligible cards: column is `review` or `running`, `projectId` matches, not in exclusion set
3. Sort:
   - Review cards first, oldest `createdAt` ascending
   - Then active running cards (`queuePosition == null`), newest `updatedAt` descending
   - Then queued running cards, `queuePosition` ascending, newest `updatedAt` as tiebreak
4. Distribute: `ranked[i]` → `slotIndices[i]`

No MobX reaction, no `useEffect`. Because `board.tsx` is `observer()`, it re-renders on every card store change and the resolver re-runs automatically.

## Actions

All mutations produce a new `SlotState[]` via an updater pattern.

**`pinSlot(index, projectId)`**

- Sets slot to `{ type: 'pinned', projectId }` — clears any existing card or override
- Guard: index 0 is a no-op

**`closeSlot(index)`**

- Sets slot to `{ type: 'empty' }` for all slot types including pinned-with-override

**`selectCard(cardId)`** (kanban click)

- If card is already visible in any slot → flash that slot, no state change
- If there is a `pinned` slot for the card's project with no current display (resolver returned nothing and no override) → set override: `{ type: 'pinned', projectId, cardId }`
- Otherwise → place in first `empty` non-hotseat slot; fall back to slot 0 as `{ type: 'manual', cardId }`

**`dropCard(slotIndex, cardId, cardProjectId)`** (all drag sources — HTML5 and dnd-kit)

- Remove card from any other slot it currently occupies
- If target slot is `pinned` and `cardProjectId === slot.projectId` → set override: `{ type: 'pinned', projectId, cardId }`
- Otherwise → set to `{ type: 'manual', cardId }` (pin cleared)
- Source slot: if it was `pinned`, leave as `{ type: 'pinned', projectId }` with no override so the resolver refills it

**`onCardCreated(cardId, projectId)`** (new card saved)

- If any slot is `pinned` to that project → do nothing; resolver re-runs naturally via observer
- Otherwise → set slot 0 to `{ type: 'manual', cardId }`

**Eviction** (card deleted)

- Runs on render: any `manual` slot or `pinned` override whose `cardId` no longer exists in the card store is cleared

## `useSlots` Hook

All slot state and actions live in a single custom hook:

```ts
function useSlots(columnCount: number): {
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
```

Internals:

- `slots` state persisted to `dispatcher-slots`
- Grows/shrinks with `columnCount` via a single `useEffect`
- Eviction runs on every render (hook lives inside `observer()`, so MobX card store changes trigger re-renders automatically)
- `resolvePinnedCards` called directly in hook body each render — no reaction, no effect
- `resolvedCards` map returned alongside `slots` so `ColumnSlot` can derive displayed card without calling the resolver itself

## `board.tsx` Changes

**Removed:**

- `columnSlots` and `columnPins` state
- `updateSlots` and `updatePins` callbacks
- The `useEffect` wiring the MobX reaction
- The `useEffect` syncing pin array length with column count
- The eviction `useEffect`
- localStorage keys `dispatcher-column-slots` and `dispatcher-column-pins`

**Replaced with:**

```ts
const { slots, resolvedCards, pinSlot, closeSlot, selectCard, dropCard, onCardCreated, flashSlot, clearFlash } =
  useSlots(columnCount);
```

**`ColumnSlot`** receives:

- `slot: SlotState` instead of separate `cardId` + `pinProjectId`
- `displayedCardId` derived inline: `slot.type === 'manual' ? slot.cardId : resolvedCards.get(index) ?? slot.cardId ?? null`
- `onDrop` calls `dropCard(index, cardId, cardProjectId)` — single unified handler for all drag sources
- `onPin`, `onClose` call `pinSlot` and `closeSlot` respectively

**`board.index.tsx` `handleDragEnd`:** replace `updateSlots` call with `dropCard(slotIdx, draggedId, draggedCard.projectId)`.

**`NewCardDetail` `onCreated` callback:** calls `onCardCreated(id, projectId)` instead of always placing in slot 0.

**Outlet context:** loses `updateSlots`, gains `dropCard` and `onCardCreated`.

## Files

| File                          | Change                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| `app/lib/resolve-pin.ts`      | Rewrite as `resolvePinnedCards` with updated signature and sort        |
| `app/lib/resolve-pin.test.ts` | Expand tests for new sort order and override exclusion                 |
| `app/lib/use-slots.ts`        | New hook — owns all slot state and actions                             |
| `app/lib/use-slots.test.ts`   | New test file for hook actions                                         |
| `app/routes/board.tsx`        | Replace slot/pin state with `useSlots` call; update `ColumnSlot` props |
| `app/routes/board.index.tsx`  | Replace `updateSlots` with `dropCard` in `handleDragEnd`               |

## Testing

**`resolvePinnedCards`** (pure function, unit tests):

- Active running card ranked above queued running cards
- Queued running cards ranked by `queuePosition` ascending
- `updatedAt` tiebreak within each group
- `pinned` slot with `cardId` override included in exclusion set
- Resolver result takes priority over override when a qualifying card exists

**`useSlots`** (hook tests via `renderHook`):

- Each action in isolation
- R7: click into empty pinned slot sets override
- R8: drag preserves pin when project matches, clears when it doesn't
- R12: new card with and without pinned slot
- Eviction on deleted card
- Column count grow/shrink
