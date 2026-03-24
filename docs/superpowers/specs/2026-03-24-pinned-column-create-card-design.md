# Pinned Column Inline Card Creation

## Problem

When a pinned column is empty (no review or running cards for that project), the user has no direct way to create a card for that project from the column itself. They must use the kanban board's `+` button, then manually set the project and status.

## Solution

Add a `+` button to the empty pinned column header. Clicking it renders `NewCardDetail` inline in that slot, pre-configured with the pinned project and "running" status, with description focused.

## Decisions

| Question                          | Decision                                                      |
| --------------------------------- | ------------------------------------------------------------- |
| Column selector                   | Visible, defaults to "running", user can change               |
| Project selector                  | Visible, defaults to pinned project, user can change          |
| Resolver finds card mid-create    | Keep showing the form, don't interrupt                        |
| Drag-drop onto slot during create | Dismiss the form, show the dropped card                       |
| X button on form                  | Closes form only (back to empty pinned state), does not unpin |
| After card creation               | Form closes, resolver takes over                              |
| `+` button style                  | Ghost button with Plus icon, matches StatusRow headers        |

## Approach

**Local state on ColumnSlot** (chosen over extending parent state or SlotState model).

A `creatingCard` boolean lives on ColumnSlot. Self-contained, no changes to the slot system, parent state, or outlet context. The two creation paths (slot-0 via `newCardColumn`, pinned via local state) are contextually different enough to justify separate triggers.

## Component Changes

### `NewCardDetail` (CardDetail.tsx)

Add optional `initialProjectId?: number` prop. When provided, the initial `draft` state computes project defaults (useWorktree, sourceBranch, model, thinkingLevel) from that project — same logic as the existing project `onValueChange` handler. All fields remain editable.

### `ColumnSlot` (board.tsx)

Add `const [creatingCard, setCreatingCard] = useState(false)`.

Render priority:

```
newCardColumn && index === 0  →  NewCardDetail (existing slot-0 flow)
creatingCard                  →  NewCardDetail (new pinned flow)
cardId != null                →  CardDetail
pinProjectId != null          →  empty pinned state (with + button)
index === 0                   →  "Select a card"
else                          →  ProjectPinSelector
```

The `+` button goes in the empty pinned header, next to the close button. Ghost button, `Plus` icon from lucide-react.

Drop handler (`handleDrop`) adds `setCreatingCard(false)` at the top so a drop dismisses the form.

## Data Flow

**Creating:** Click `+` → `setCreatingCard(true)`. `NewCardDetail` renders with `column="running"`, `initialProjectId={pinProjectId}`. `onColorChange` wired to `setDraftColor` for live divider color updates.

**Saving:** `onCreated` sets `setCreatingCard(false)` and calls `onCardCreated(id, projectId)`. Resolver picks up the new card. If project matches the pin, it resolves into this slot. If user changed the project, slot returns to empty pinned state.

**Canceling:** `onClose` sets `setCreatingCard(false)`. Slot returns to empty pinned state.

**Drag-drop interrupt:** `handleDrop` sets `setCreatingCard(false)` before processing the drop.

## Edge Cases

- **Resolver finds card mid-create:** `creatingCard` checked before `cardId` in render priority — form stays visible until save/cancel.
- **Slot closed externally:** React unmounts ColumnSlot, local state cleaned up naturally.
- **Multiple pinned slots for same project:** Independent `creatingCard` state. Both could show forms simultaneously — unlikely but harmless.

## Scope

- Two files changed: `CardDetail.tsx`, `board.tsx`
- No server changes, no new wire protocol, no data model changes
- No new dependencies
