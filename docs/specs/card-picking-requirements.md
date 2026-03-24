# Card Picking Logic — Requirements

## R1. Slot types

- Slot 0 ("hotseat") is always manually managed — never auto-managed, never pinnable
- Slots 1+ can be either **pinned** (auto-managed to a project) or **manual** (user explicitly placed a card)
- Pinned and manual are mutually exclusive states per slot

## R2. Eligible cards

- Only `review` and `running` column cards qualify for pinned slots
- Cards with no `projectId` are never eligible

## R3. Priority ordering

- Review cards rank above running cards
- Review cards sorted oldest `createdAt` first
- Running cards sorted: active session first (queuePosition == null), then queued cards by `queuePosition` ascending — ties within each group broken by newest `updatedAt` first

## R4. Multi-slot distribution

- Multiple slots pinned to the same project distribute the ranked list across them in slot-index order (lower index = higher priority card)

## R5. Deduplication

- A card already visible in any slot must not appear in a second slot

## R6. Resolver triggers

- Re-runs whenever the card store changes
- Re-runs immediately when a slot's pin changes

## R7. Manual card placement via click

- If the card is already visible in any slot, flash that slot instead
- If there is a pinned slot for the card's project that is currently empty, place it there
- Otherwise, place it in the first empty manual slot; fall back to slot 0

## R8. Manual card placement via drag

- Dragging a card into any slot converts that slot to manual (clears any existing pin), unless the card belongs to the pinned project — in which case the pin is preserved
- The source slot's pin is preserved so the resolver can immediately refill it
- The dragged card is removed from any other slot it was already in

## R9. Pin lifecycle

- Pin is set via the project picker on empty unpinned slots 1+
- Pin is cleared by: user closes the slot (X button), a card is dragged onto the slot (unless the card matches the pinned project), or the column is removed

## R10. Flash animation

- A slot flashes when a new card appears in it (resolver or manual placement)
- No flash when a slot empties

## R11. Persistence

- `columnSlots` and `columnPins` are persisted to localStorage
- Both arrays are kept in sync with `columnCount`
- Deleted cards are evicted from slots automatically

## R12. New card creation

- When a new card is saved and there is a pinned slot for its project: slot 0 goes empty and the resolver recalculates — the new card surfaces in the pinned slot if it qualifies
- When a new card is saved and there is no pinned slot for its project: the new card is placed in slot 0 (existing behavior)
