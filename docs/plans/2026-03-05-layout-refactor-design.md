# Layout Refactor Design

## Overview

Refactor the page layout from a horizontal kanban board with a slide-over detail panel to:
- Persistent right panel (card detail) on desktop
- Horizontal rows (cards flow left-to-right) replacing vertical columns
- Separate routes for backlog and done
- Mobile responsive (Sheet overlay for card detail)

## Routes

- `/` (layout route) — header, nav, two-panel shell, `<Outlet>`
  - `/` (index) — active board: Ready, In Progress, Review rows
  - `/backlog` — Backlog row
  - `/done` — Done row
- `/settings/repos` — unchanged

Selected card stored in URL search param: `?card=5`.

## Desktop Layout (lg+)

```
+-- Header (nav buttons, search, settings) -------------+
+-- Left (flex-1, scrollable) --+--+-- Right (~400px) ---+
|                               |R |                     |
|  Ready row                    |E |  Card Detail        |
|  [card] [card] [card]        |S |  (or empty state)   |
|                               |I |                     |
|  In Progress row              |Z |  Status dropdown    |
|  [card] [card]               |E |  Title, desc, etc.  |
|                               |  |                     |
|  Review row                   |  |  Save button        |
|  [card] [card] [card]        |  |  Close button        |
|                               |  |                     |
+-------------------------------+--+---------------------+
```

- Draggable resize handle between panels
- Right panel: min 300px, max 600px, default 400px
- Width persisted to localStorage
- Close button on detail panel clears `?card` param

## Mobile Layout (<lg)

- Right panel hidden
- Full-width horizontal rows stack vertically
- Tapping card opens `CardDetailPanel` as Sheet (slide-over)
- No resize handle

## Horizontal Rows (StatusRow)

Each row:
- Header: status label, card count badge, + button
- Cards in horizontal scrollable flex container
- DnD: `horizontalListSortingStrategy` per row
- Cross-row DnD: drag vertically between rows to change status
- Collision detection: `pointerWithin` for row, `closestCenter` for position

## Card Detail Panel

- `CardDetail` component: pure content, no Sheet wrapper
- Desktop: rendered inline in right panel
- Mobile: rendered inside `Sheet` wrapper
- Changes from current:
  - Status dropdown added (updates board via invalidateQueries)
  - Explicit Save button (replaces auto-save-on-blur)
  - Close button (clears card selection)
  - Save button disabled when clean, enabled+highlighted when dirty

## Component Structure

### New
- `BoardLayout` — layout route: header, nav, two-panel shell with resize handle
- `CardDetail` — extracted card detail content with status dropdown + Save
- `CardDetailSheet` — Sheet wrapper around CardDetail for mobile
- `StatusRow` — horizontal scrollable row of cards with DnD

### Removed
- `Column` — replaced by StatusRow
- `CardDetailPanel` — split into CardDetail + CardDetailSheet

### Unchanged
- `Card`, `CardOverlay`, `SearchBar`, `MessageBlock`, `SessionView`

## DnD Changes

- `verticalListSortingStrategy` -> `horizontalListSortingStrategy`
- Cards in flex-row with overflow-x-auto
- Cross-row drag: vertical movement across row boundaries
- Same snapshotRef pattern for cross-row moves
- calcPosition logic unchanged
- DnD context per page (not shared across routes)

## Card Creation

- + button on every row/status
- Creates card and opens in detail panel
- No auto-save; explicit Save button required
