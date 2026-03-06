# Layout Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor from horizontal kanban columns + sheet detail panel to horizontal card rows + persistent right detail panel, with separate routes for backlog/done.

**Architecture:** React Router 7 layout route renders shared two-panel shell (rows left, card detail right). Child routes render their rows into `<Outlet>`. Selected card tracked via `?card=N` URL search param. Resize handle between panels persists width to localStorage. Mobile falls back to Sheet overlay.

**Tech Stack:** React Router 7 (layout routes), @dnd-kit (horizontal strategy), Tailwind CSS, shadcn/ui

---

### Task 1: Route Configuration

**Files:**
- Modify: `app/routes.ts`
- Create: `app/routes/board.tsx` (layout route)
- Create: `app/routes/board.index.tsx` (active board — ready, in_progress, review)
- Create: `app/routes/board.backlog.tsx` (backlog)
- Create: `app/routes/board.done.tsx` (done)

**Step 1: Update route config**

```ts
// app/routes.ts
import { type RouteConfig, route, index, layout } from "@react-router/dev/routes";

export default [
  layout("routes/board.tsx", [
    index("routes/board.index.tsx"),
    route("backlog", "routes/board.backlog.tsx"),
    route("done", "routes/board.done.tsx"),
  ]),
  route("api/trpc/*", "routes/api.trpc.$.ts"),
  route("settings/repos", "routes/settings.repos.tsx"),
] satisfies RouteConfig;
```

**Step 2: Create placeholder layout route**

```tsx
// app/routes/board.tsx
import { Outlet } from "react-router";

export default function BoardLayout() {
  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-950">
      <header className="shrink-0 px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Conductor</h1>
        <span className="text-sm text-muted-foreground">Layout placeholder</span>
      </header>
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
```

**Step 3: Create placeholder child routes**

```tsx
// app/routes/board.index.tsx
export default function ActiveBoard() {
  return <div className="p-4">Active Board (ready, in_progress, review)</div>;
}
```

```tsx
// app/routes/board.backlog.tsx
export default function BacklogBoard() {
  return <div className="p-4">Backlog</div>;
}
```

```tsx
// app/routes/board.done.tsx
export default function DoneBoard() {
  return <div className="p-4">Done</div>;
}
```

**Step 4: Delete old home route**

Delete `app/routes/home.tsx` — the index route replaces it.

**Step 5: Verify dev server loads**

Run: `pnpm dev` and visit `/`, `/backlog`, `/done` — should see placeholders.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: route config for layout refactor with placeholder routes"
```

---

### Task 2: BoardLayout — Header with Nav Buttons

**Files:**
- Modify: `app/routes/board.tsx`

**Step 1: Build the header with nav, search, settings**

```tsx
// app/routes/board.tsx
import { Outlet, Link, useLocation } from "react-router";
import { Settings } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { SearchBar } from '~/components/SearchBar';
import { useState, useRef } from 'react';

const NAV_ITEMS = [
  { to: '/', label: 'Board' },
  { to: '/backlog', label: 'Backlog' },
  { to: '/done', label: 'Done' },
] as const;

export default function BoardLayout() {
  const location = useLocation();
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-950">
      <header className="shrink-0 px-4 sm:px-6 py-3 border-b border-gray-200 dark:border-gray-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Conductor</h1>
          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map(({ to, label }) => (
              <Button
                key={to}
                variant={location.pathname === to ? 'default' : 'ghost'}
                size="sm"
                asChild
              >
                <Link to={to}>{label}</Link>
              </Button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 flex-1 min-w-0 justify-end">
          <SearchBar ref={searchRef} value={search} onChange={setSearch} />
          <Button variant="ghost" size="icon" asChild className="shrink-0 text-muted-foreground">
            <Link to="/settings/repos" title="Settings">
              <Settings className="size-5" />
            </Link>
          </Button>
        </div>
      </header>
      <div className="flex-1 overflow-hidden">
        <Outlet context={{ search }} />
      </div>
    </div>
  );
}
```

Note: Pass `search` via Outlet context so child routes can filter cards.

**Step 2: Verify**

Run dev server — header should show nav buttons, search bar, settings. Nav highlights current route.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: board layout header with nav buttons, search, settings"
```

---

### Task 3: Two-Panel Shell with Resizable Divider

**Files:**
- Modify: `app/routes/board.tsx`
- Create: `app/components/ResizeHandle.tsx`

**Step 1: Create ResizeHandle component**

```tsx
// app/components/ResizeHandle.tsx
import { useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'conductor-panel-width';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 300;
const MAX_WIDTH = 600;

export function useResizablePanel() {
  const panelRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(getStoredWidth());

  function getStoredWidth(): number {
    if (typeof window === 'undefined') return DEFAULT_WIDTH;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const n = Number(stored);
      if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
    }
    return DEFAULT_WIDTH;
  }

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;

    function onMouseMove(e: MouseEvent) {
      const delta = startX - e.clientX;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      widthRef.current = newWidth;
      if (panelRef.current) {
        panelRef.current.style.width = `${newWidth}px`;
      }
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(STORAGE_KEY, String(widthRef.current));
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  return { panelRef, initialWidth: widthRef.current, onMouseDown };
}

export function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 hover:w-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors shrink-0 hidden lg:block"
    />
  );
}
```

**Step 2: Add two-panel layout to BoardLayout**

Update `app/routes/board.tsx` to include the two-panel shell below the header:

```tsx
// Replace the <div className="flex-1 overflow-hidden"> section with:
import { ResizeHandle, useResizablePanel } from '~/components/ResizeHandle';
import { useSearchParams } from 'react-router';

// Inside BoardLayout:
const [searchParams, setSearchParams] = useSearchParams();
const selectedCardId = searchParams.get('card') ? Number(searchParams.get('card')) : null;
const { panelRef, initialWidth, onMouseDown } = useResizablePanel();

function selectCard(id: number | null) {
  setSearchParams(prev => {
    if (id === null) {
      prev.delete('card');
    } else {
      prev.set('card', String(id));
    }
    return prev;
  }, { replace: true });
}

// JSX:
<div className="flex-1 flex overflow-hidden">
  {/* Left: rows */}
  <div className="flex-1 min-w-0 overflow-y-auto">
    <Outlet context={{ search, selectedCardId, selectCard }} />
  </div>

  {/* Resize handle (desktop only) */}
  <ResizeHandle onMouseDown={onMouseDown} />

  {/* Right: detail panel (desktop only) */}
  <div
    ref={panelRef}
    className="hidden lg:flex flex-col border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden"
    style={{ width: initialWidth }}
  >
    {selectedCardId ? (
      <div className="p-4 text-sm">Card {selectedCardId} detail placeholder</div>
    ) : (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Select a card to view details
      </div>
    )}
  </div>
</div>
```

**Step 3: Verify**

Resize handle visible on desktop, drag it to resize panel. Width persists on refresh. Panel hidden on mobile.

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: two-panel layout with resizable divider and localStorage persistence"
```

---

### Task 4: Extract CardDetail from CardDetailPanel

**Files:**
- Create: `app/components/CardDetail.tsx`
- Modify: `app/components/CardDetailPanel.tsx` (eventually delete)

**Step 1: Create CardDetail component**

Extract the inner content from `CardDetailPanel` into a standalone `CardDetail` component. This component takes `cardId` and `onClose` props, renders everything that was inside `SheetContent` (minus the Sheet wrapper):

- Status dropdown (new — use the existing Select component)
- Title (editable for backlog/ready)
- Description (editable for backlog/ready)
- Fields (priority, repo, worktree, source branch)
- Save button (new — replaces auto-save-on-blur)
- Session view (for in_progress/review)
- Close button (X in top-right)

Key changes from CardDetailPanel:
1. **No Sheet wrapper** — just the content
2. **Status dropdown** — new Select field that calls `cards.move` mutation
3. **Save button** — collect all edits in local state, persist on Save click
4. **Close button** — calls `onClose` prop
5. **All fields editable always** (not conditional on column) — since status can change via dropdown

The component should:
- Load card data from `trpc.cards.list` query (same pattern as today)
- Track dirty state: `useState` for draft fields, compare to server values
- Save button enabled only when dirty
- On Save: call `cards.update` mutation with all changed fields, then invalidate queries
- Status change: call `cards.move` directly (no save button needed for status)

```tsx
// app/components/CardDetail.tsx — key structure
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SessionView } from './SessionView';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '~/components/ui/select';
import { Badge } from '~/components/ui/badge';
import { Checkbox } from '~/components/ui/checkbox';

type Props = {
  cardId: number;
  onClose: () => void;
};

const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done'] as const;
const statusLabels: Record<string, string> = {
  backlog: 'Backlog', ready: 'Ready', in_progress: 'In Progress', review: 'Review', done: 'Done',
};
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const priorityLabels: Record<string, string> = {
  low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent',
};

export function CardDetail({ cardId, onClose }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: allCards } = useQuery(trpc.cards.list.queryOptions());
  const card = allCards?.find((c) => c.id === cardId);
  const { data: repos } = useQuery(trpc.repos.list.queryOptions());

  // Draft state for editable fields
  const [draft, setDraft] = useState({ title: '', description: '', priority: '', repoId: null as number | null, useWorktree: false, sourceBranch: null as string | null });

  // Sync draft when card data arrives or cardId changes
  useEffect(() => {
    if (card) {
      setDraft({
        title: card.title,
        description: card.description ?? '',
        priority: card.priority,
        repoId: card.repoId,
        useWorktree: card.useWorktree,
        sourceBranch: card.sourceBranch,
      });
    }
  }, [card?.id, card?.updatedAt]);

  const isDirty = card && (
    draft.title !== card.title ||
    draft.description !== (card.description ?? '') ||
    draft.priority !== card.priority ||
    draft.repoId !== card.repoId ||
    draft.useWorktree !== card.useWorktree ||
    draft.sourceBranch !== card.sourceBranch
  );

  const updateMutation = useMutation(
    trpc.cards.update.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() }),
    })
  );

  const moveMutation = useMutation(
    trpc.cards.move.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() }),
    })
  );

  function handleSave() {
    if (!card || !isDirty) return;
    updateMutation.mutate({
      id: card.id,
      title: draft.title,
      description: draft.description || null,
      priority: draft.priority,
      repoId: draft.repoId,
      useWorktree: draft.useWorktree,
      sourceBranch: draft.sourceBranch,
    });
  }

  function handleStatusChange(newStatus: string) {
    if (!card || newStatus === card.column) return;
    moveMutation.mutate({ id: card.id, column: newStatus, position: 999 });
  }

  if (!card) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Card not found
      </div>
    );
  }

  const col = card.column as string;
  const selectedRepo = repos?.find(r => r.id === draft.repoId);

  return (
    <div className="flex flex-col h-full">
      {/* Header with close button */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <Badge variant="outline" className="uppercase text-xs tracking-wide">
          {statusLabels[col] ?? col}
        </Badge>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-4 space-y-4">
          {/* Status */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Status</label>
            <Select value={col} onValueChange={handleStatusChange}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map(s => (
                  <SelectItem key={s} value={s}>{statusLabels[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Title</label>
            <Input
              value={draft.title}
              onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
            <Textarea
              value={draft.description}
              onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
              rows={4}
              placeholder="Add a description..."
              className="resize-y"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Priority</label>
            <Select value={draft.priority} onValueChange={val => setDraft(d => ({ ...d, priority: val }))}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRIORITIES.map(p => (
                  <SelectItem key={p} value={p}>{priorityLabels[p]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Repo */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Repository</label>
            <Select
              value={draft.repoId != null ? String(draft.repoId) : '__none__'}
              onValueChange={val => setDraft(d => ({ ...d, repoId: val === '__none__' ? null : Number(val) }))}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {repos?.map(r => (
                  <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Worktree checkbox */}
          {selectedRepo?.isGitRepo && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="useWorktree"
                checked={draft.useWorktree}
                disabled={!!card.worktreePath}
                onCheckedChange={checked => setDraft(d => ({ ...d, useWorktree: checked === true }))}
              />
              <label htmlFor="useWorktree" className="text-sm font-medium text-muted-foreground">
                Use worktree
              </label>
            </div>
          )}

          {/* Source branch */}
          {selectedRepo?.isGitRepo && draft.useWorktree && (
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Source Branch</label>
              <Select
                value={draft.sourceBranch ?? selectedRepo.defaultBranch ?? ''}
                onValueChange={val => setDraft(d => ({ ...d, sourceBranch: val }))}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="main">main</SelectItem>
                  <SelectItem value="dev">dev</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Save button */}
        <div className="px-4 pb-4 shrink-0">
          <Button
            className="w-full"
            disabled={!isDirty || updateMutation.isPending}
            onClick={handleSave}
          >
            {updateMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>

        {/* Session view */}
        {(col === 'in_progress' || col === 'review') && (
          card.repoId || card.worktreePath ? (
            <SessionView cardId={card.id} sessionId={card.sessionId} />
          ) : (
            <div className="px-4 text-sm text-muted-foreground italic">
              No repo linked - assign a repo to enable Claude sessions
            </div>
          )
        )}
      </div>
    </div>
  );
}
```

**Step 2: Verify**

The component is not wired up yet — just ensure it compiles. `pnpm build` should succeed (or at least no type errors in this file).

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: extract CardDetail component with status dropdown and save button"
```

---

### Task 5: Wire CardDetail into BoardLayout

**Files:**
- Modify: `app/routes/board.tsx`
- Modify: `app/components/CardDetailPanel.tsx` → keep as mobile-only Sheet wrapper

**Step 1: Desktop — render CardDetail in right panel**

Update the right panel section in `app/routes/board.tsx`:

```tsx
import { CardDetail } from '~/components/CardDetail';

// In the right panel div:
{selectedCardId ? (
  <CardDetail cardId={selectedCardId} onClose={() => selectCard(null)} />
) : (
  <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
    Select a card to view details
  </div>
)}
```

**Step 2: Mobile — Sheet wrapper**

Create a simple wrapper that uses the existing Sheet for mobile:

```tsx
// In board.tsx, below the desktop panel:
// Mobile sheet (shown only on <lg when card is selected)
{selectedCardId && (
  <div className="lg:hidden">
    <Sheet open={true} onOpenChange={() => selectCard(null)}>
      <SheetContent side="right" className="w-full sm:w-[400px] p-0 flex flex-col">
        <SheetHeader className="sr-only">
          <SheetTitle>Card Detail</SheetTitle>
          <SheetDescription>Card detail panel</SheetDescription>
        </SheetHeader>
        <CardDetail cardId={selectedCardId} onClose={() => selectCard(null)} />
      </SheetContent>
    </Sheet>
  </div>
)}
```

**Step 3: Verify**

Desktop: clicking a card shows detail in right panel. Close button works. Mobile: shows Sheet.

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: wire CardDetail into layout — persistent panel on desktop, sheet on mobile"
```

---

### Task 6: StatusRow Component

**Files:**
- Create: `app/components/StatusRow.tsx`

**Step 1: Build StatusRow — horizontal scrollable card row**

```tsx
// app/components/StatusRow.tsx
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { Card } from './Card';

export type ColumnId = 'backlog' | 'ready' | 'in_progress' | 'review' | 'done';

const displayNames: Record<ColumnId, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

interface CardItem {
  id: number;
  title: string;
  priority: string;
  position: number;
}

interface StatusRowProps {
  id: ColumnId;
  cards: CardItem[];
  onCardClick?: (id: number) => void;
  onAddCard?: (column: ColumnId) => void;
}

export function StatusRow({ id, cards, onCardClick, onAddCard }: StatusRowProps) {
  const { setNodeRef } = useDroppable({ id });

  return (
    <div className="shrink-0">
      <div className="flex items-center gap-2 px-4 py-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {displayNames[id]}
        </h2>
        <Badge variant="secondary">{cards.length}</Badge>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onAddCard?.(id)}
          title="Add card"
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <div
        ref={setNodeRef}
        className="flex gap-2 px-4 pb-3 overflow-x-auto min-h-[3.5rem]"
      >
        <SortableContext items={cards.map(c => c.id)} strategy={horizontalListSortingStrategy}>
          {cards.map(card => (
            <Card key={card.id} id={card.id} title={card.title} priority={card.priority} onClick={onCardClick} />
          ))}
        </SortableContext>
        {cards.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-gray-600 py-2">
            No cards
          </p>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Update Card component for horizontal layout**

The Card component currently has no explicit width. Add a fixed width so cards don't collapse in horizontal flow:

In `app/components/Card.tsx`, update the card's outer div className:
- Add `w-56 shrink-0` to give cards a fixed width in horizontal mode

Similarly update `CardOverlay` width from `w-72` to `w-56`.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: StatusRow component with horizontal card layout"
```

---

### Task 7: Active Board Route (Ready, In Progress, Review)

**Files:**
- Modify: `app/routes/board.index.tsx`

**Step 1: Implement the active board with DnD**

Port the DnD logic from `Board.tsx` into `board.index.tsx`, adapted for horizontal rows. The key changes:
- Only 3 columns: `ready`, `in_progress`, `review`
- Uses `StatusRow` instead of `Column`
- Cross-row drag (vertical movement between rows) changes status
- Gets `search`, `selectedCardId`, `selectCard` from outlet context
- Uses `horizontalListSortingStrategy` per row (already in StatusRow)

```tsx
// app/routes/board.index.tsx
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor,
  useSensors, useSensor, pointerWithin, closestCenter, getFirstCollision,
  MeasuringStrategy,
  type DragStartEvent, type DragOverEvent, type DragEndEvent,
  type CollisionDetection, type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { StatusRow, type ColumnId } from '~/components/StatusRow';
import { CardOverlay } from '~/components/Card';

type BoardContext = {
  search: string;
  selectedCardId: number | null;
  selectCard: (id: number | null) => void;
};

// Same CardItem interface, groupByColumn, calcPosition, findColumn as Board.tsx
// but ACTIVE_COLUMNS = ['ready', 'in_progress', 'review']

const ACTIVE_COLUMNS: ColumnId[] = ['ready', 'in_progress', 'review'];

// ... (port groupByColumn, calcPosition, findColumn from Board.tsx, scoped to ACTIVE_COLUMNS)

export default function ActiveBoard() {
  const { search, selectedCardId, selectCard } = useOutletContext<BoardContext>();
  // ... port all DnD logic from Board.tsx, replacing Column with StatusRow,
  //     COLUMNS with ACTIVE_COLUMNS, and using selectCard instead of setSelectedCardId
  //     Also add createMutation that calls selectCard on success
}
```

The DnD logic stays almost identical to `Board.tsx`. Key differences:
- `COLUMNS` → `ACTIVE_COLUMNS`
- `Column` → `StatusRow`
- `setSelectedCardId` → `selectCard` (from context)
- Keyboard shortcut `n` creates card in `ready` (first active column)
- `onCardClick` calls `selectCard`

**Step 2: Verify**

Active board at `/` shows 3 horizontal rows. Cards can be dragged within and between rows. Clicking a card shows it in the right panel.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: active board route with horizontal rows and cross-row DnD"
```

---

### Task 8: Backlog Route

**Files:**
- Modify: `app/routes/board.backlog.tsx`

**Step 1: Implement backlog page**

Same pattern as active board but with only one column (`backlog`). DnD only for reordering within the row (no cross-row since there's one row).

```tsx
// app/routes/board.backlog.tsx
// Simplified version of board.index.tsx with single column 'backlog'
// Still has DnD for reordering, create button, search filtering
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: backlog route with single horizontal row"
```

---

### Task 9: Done Route

**Files:**
- Modify: `app/routes/board.done.tsx`

**Step 1: Implement done page**

Same as backlog but for `done` column.

```tsx
// app/routes/board.done.tsx
// Same pattern as backlog with single column 'done'
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: done route with single horizontal row"
```

---

### Task 10: Keyboard Shortcuts

**Files:**
- Modify: `app/routes/board.tsx`

**Step 1: Add global keyboard shortcuts in the layout**

Move keyboard shortcut handling from Board.tsx to the layout:
- `/` — focus search bar
- `n` — create card (in first column of current route: ready for `/`, backlog for `/backlog`, done for `/done`)
- `Escape` — deselect card (clear `?card` param)

The `n` shortcut needs to know which page we're on. Pass a `createInColumn` callback via context, or handle it per-route.

Simpler: keep `Escape` and `/` in layout, let each child route handle `n` since it needs the create mutation with the right default column.

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: keyboard shortcuts in layout"
```

---

### Task 11: Cleanup Old Components

**Files:**
- Delete: `app/components/Board.tsx`
- Delete: `app/components/Column.tsx`
- Delete: `app/components/CardDetailPanel.tsx`
- Delete: `app/routes/home.tsx`

**Step 1: Remove old files**

Delete files that are fully replaced by the new layout.

**Step 2: Search for any remaining imports of deleted files**

```bash
grep -r "Board\|Column\|CardDetailPanel\|home" app/ --include="*.tsx" --include="*.ts"
```

Fix any remaining references.

**Step 3: Verify build**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: remove old Board, Column, CardDetailPanel, home route"
```

---

### Task 12: Browser Testing

**Step 1: Test desktop layout**
- All 3 routes render with horizontal rows
- Right panel shows card detail, empty state works
- Resize handle works, width persists across refresh
- Close button clears selection
- Status dropdown moves cards between rows (and routes)
- Save button works for field edits
- DnD works within and between rows on active board
- DnD works for reorder on backlog and done pages
- Search filters cards
- Nav buttons highlight current route

**Step 2: Test mobile layout**
- Right panel hidden
- Tapping card opens Sheet
- Sheet has all card detail functionality
- Rows scroll horizontally

**Step 3: Fix any issues found**

**Step 4: Commit fixes**

```bash
git add -A && git commit -m "fix: browser testing fixes for layout refactor"
```
