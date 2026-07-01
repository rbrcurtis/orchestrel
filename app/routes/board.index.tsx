import { useState, useCallback, useRef, useMemo, useEffect, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { observer } from 'mobx-react-lite';
import { useOutletContext } from 'react-router';
import { Button } from '~/components/ui/button';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  pointerWithin,
  rectIntersection,
  closestCenter,
  getFirstCollision,
  MeasuringStrategy,
  type DragStartEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragEndEvent,
  type CollisionDetection,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { useCardStore, useProjectStore } from '~/stores/context';
import { StatusRow, ALL_COLUMNS, type ColumnId } from '~/components/StatusRow';
import { CardOverlay } from '~/components/Card';
import type { Card } from '../../src/shared/ws-protocol';
import type { SlotState } from '~/lib/resolve-pin';

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

const ACTIVE_COLUMNS: ColumnId[] = ['backlog', 'ready', 'running', 'review', 'done'];
const BACKLOG_PAGE_SIZE = 50;

interface CardItem {
  id: number;
  title: string;
  description: string | null;
  column: string;
  position: number;
  projectId: number | null;
  prUrl: string | null;
  sessionId: string | null;
  worktreeBranch: string | null;
  promptsSent: number;
  turnsCompleted: number;
  createdAt: string;
  updatedAt: string;
  color?: string | null;
}

type ColumnCards = Record<ColumnId, CardItem[]>;

function findColumnInData(data: ColumnCards, id: UniqueIdentifier): ColumnId | null {
  if (ACTIVE_COLUMNS.includes(id as ColumnId)) return id as ColumnId;
  for (const col of ACTIVE_COLUMNS) {
    if (data[col].some((c) => c.id === id)) return col;
  }
  return null;
}

function enrichCard(card: Card, colorMap: Record<number, string>): CardItem {
  return {
    ...card,
    color: card.projectId ? (colorMap[card.projectId] ?? null) : null,
  };
}

function findColumnSlotAtPoint(x: number, y: number): number | null {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    const slot = (el as HTMLElement).closest('[data-column-slot]');
    if (slot) return Number((slot as HTMLElement).dataset.columnSlot);
  }
  return null;
}

const ActiveBoard = observer(function ActiveBoard() {
  const { search, projectFilter, selectCard, startNewCard, dropCard } = useOutletContext<BoardContext>();
  const cardStore = useCardStore();
  const projectStore = useProjectStore();

  // Build color map from projects (no useMemo — observer tracks MobX reads)
  const colorMap: Record<number, string> = {};
  for (const p of projectStore.all) {
    if (p.color) colorMap[p.id] = p.color;
  }

  // Read store cards per column (no useMemo — observer tracks MobX reads)
  const storeColumns: ColumnCards = {
    backlog: [],
    ready: [],
    running: [],
    review: [],
    done: [],
    archive: [],
  };
  for (const col of ACTIVE_COLUMNS) {
    storeColumns[col] = cardStore.cardsByColumn(col).map((c) => enrichCard(c, colorMap));
  }

  // During drag: local override; after drag ends: null → use storeColumns
  const [dragOverride, setDragOverride] = useState<ColumnCards | null>(null);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const snapshotRef = useRef<ColumnCards | null>(null);
  const [mounted] = useState(true);

  // Backlog is lazy-paged (not part of the board subscribe) — page it in here,
  // 50 at a time, mirroring the archive route. Cards are ordered position ASC on
  // both the server (pageCards) and the client (cardsByColumn), so each page is
  // contiguous with what's already shown and "Load more" appends the next slice.
  const [backlogTotal, setBacklogTotal] = useState(0);
  const [backlogHasMore, setBacklogHasMore] = useState(true);
  const [backlogLoading, setBacklogLoading] = useState(false);

  function loadBacklogPage() {
    if (backlogLoading) return;
    // Derive the cursor from the LAST backlog card already loaded (max position,
    // id as tiebreak) rather than tracking a page number — the store can be
    // pre-filled from persistence or live-merged cards, so a fixed cursor would
    // re-fetch loaded pages. The tail self-heals against whatever is in the store.
    let tail: { id: number; position: number } | undefined;
    for (const c of cardStore.cardsByColumn('backlog')) {
      if (!tail || c.position > tail.position || (c.position === tail.position && c.id > tail.id)) {
        tail = c;
      }
    }
    setBacklogLoading(true);
    cardStore
      .loadPage('backlog', tail?.id, BACKLOG_PAGE_SIZE)
      .then((r) => {
        setBacklogTotal(r.total);
        setBacklogHasMore(r.nextCursor !== undefined);
      })
      .finally(() => setBacklogLoading(false));
  }

  useEffect(() => {
    loadBacklogPage();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Backlog is paged, so a typed query must hit the server to reach unloaded
  // backlog cards (debounced); matches merge into the store and the client-side
  // filter below then shows them alongside the other active columns.
  useEffect(() => {
    if (search.length === 0) return;
    const t = setTimeout(() => void cardStore.search(search), 250);
    return () => clearTimeout(t);
  }, [search, cardStore]);

  // Active columns data: override during drag, store otherwise
  const columns = dragOverride ?? storeColumns;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const lastPointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      // First try pointerWithin
      const pwCollisions = pointerWithin(args);
      if (pwCollisions.length > 0) {
        const overId = getFirstCollision(pwCollisions, 'id');
        lastOverId.current = overId;
        if (overId != null) {
          // If over a column, find the closest card within it
          if (ACTIVE_COLUMNS.includes(overId as ColumnId)) {
            const colCards = columns[overId as ColumnId];
            if (colCards.length > 0) {
              const closestInCol = closestCenter({
                ...args,
                droppableContainers: args.droppableContainers.filter(
                  (c) => c.id === overId || colCards.some((card) => card.id === c.id),
                ),
              });
              if (closestInCol.length > 0) return closestInCol;
            }
          }
          return pwCollisions;
        }
      }

      // Fallback to rectIntersection
      const riCollisions = rectIntersection(args);
      if (riCollisions.length > 0) {
        lastOverId.current = getFirstCollision(riCollisions, 'id');
        return riCollisions;
      }

      // Last resort: closestCenter
      const ccCollisions = closestCenter(args);
      lastOverId.current = getFirstCollision(ccCollisions, 'id');
      return ccCollisions;
    },
    [columns],
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(e.active.id);
    // Snapshot the store columns at drag start
    const snap: ColumnCards = { ...storeColumns };
    for (const col of ACTIVE_COLUMNS) {
      snap[col] = [...storeColumns[col]];
    }
    snapshotRef.current = snap;
    setDragOverride(snap);
  }

  function handleDragMove(e: DragMoveEvent) {
    const evt = e.activatorEvent as PointerEvent;
    if (evt) {
      const delta = e.delta;
      lastPointer.current = { x: evt.clientX + delta.x, y: evt.clientY + delta.y };
    }
  }

  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;

    const activeCol = snapshotRef.current
      ? findColumnInData(snapshotRef.current, active.id)
      : findColumnInData(columns, active.id);
    const overCol = findColumnInData(columns, over.id);
    const currentCol = findColumnInData(columns, active.id);

    if (activeCol === 'running' && overCol !== 'done' && overCol !== 'archive') {
      return;
    }

    if (!currentCol || !overCol || currentCol === overCol) return;

    setDragOverride((prev) => {
      const cur = prev ?? storeColumns;
      const sourceCards = [...cur[currentCol]];
      const destCards = [...cur[overCol]];

      const activeIdx = sourceCards.findIndex((c) => c.id === active.id);
      if (activeIdx === -1) return prev;

      const [moved] = sourceCards.splice(activeIdx, 1);

      const overIdx = destCards.findIndex((c) => c.id === over.id);
      const insertIdx = overIdx === -1 ? destCards.length : overIdx;

      destCards.splice(insertIdx, 0, { ...moved, column: overCol });

      return { ...cur, [currentCol]: sourceCards, [overCol]: destCards };
    });
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;

    // Check if dropped over a column slot (right panel)
    const slotIdx = findColumnSlotAtPoint(lastPointer.current.x, lastPointer.current.y);
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

    if (!over) {
      setActiveId(null);
      setDragOverride(null);
      snapshotRef.current = null;
      return;
    }

    const currentCol = findColumnInData(columns, active.id);
    const originalCol = snapshotRef.current ? findColumnInData(snapshotRef.current, active.id) : currentCol;

    if (!currentCol || !originalCol) {
      setActiveId(null);
      setDragOverride(null);
      snapshotRef.current = null;
      return;
    }

    // Running cards can only move to done/archive
    if (originalCol === 'running' && currentCol !== 'done' && currentCol !== 'archive') {
      setDragOverride(null);
      setActiveId(null);
      snapshotRef.current = null;
      return;
    }

    if (originalCol === currentCol) {
      // Same column reorder
      const colCards = columns[currentCol];
      const oldIdx = colCards.findIndex((c) => c.id === active.id);
      const newIdx = colCards.findIndex((c) => c.id === over.id);

      if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
        const reordered = arrayMove(colCards, oldIdx, newIdx);
        setDragOverride((prev) => ({ ...(prev ?? storeColumns), [currentCol]: reordered }));

        cardStore.updateCard({ id: active.id as number, column: currentCol }).finally(() => setDragOverride(null));
      } else {
        setDragOverride(null);
      }
    } else {
      // Cross-column move — handleDragOver already moved it visually, persist it
      cardStore.updateCard({ id: active.id as number, column: currentCol }).finally(() => setDragOverride(null));
    }

    setActiveId(null);
    snapshotRef.current = null;
  }

  function handleDragCancel() {
    setDragOverride(null);
    setActiveId(null);
    snapshotRef.current = null;
  }

  const filteredColumns = useMemo(() => {
    const hasSearch = search.length > 0;
    const hasProject = projectFilter.size > 0;
    if (!hasSearch && !hasProject) return columns;
    const q = search.toLowerCase();
    const result = {} as ColumnCards;
    for (const col of ALL_COLUMNS) {
      result[col] = columns[col].filter((c) => {
        if (hasProject && !projectFilter.has(c.projectId ?? -1)) return false;
        if (
          hasSearch &&
          !c.title.toLowerCase().includes(q) &&
          !(c.description && c.description.toLowerCase().includes(q))
        )
          return false;
        return true;
      });
    }
    return result;
  }, [columns, search, projectFilter]);

  const activeCard = useMemo(() => {
    if (!activeId) return null;
    for (const col of ACTIVE_COLUMNS) {
      const card = columns[col].find((c) => c.id === activeId);
      if (card) return card;
    }
    return null;
  }, [activeId, columns]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
    >
      <div className="flex flex-col gap-2 p-4">
        {ACTIVE_COLUMNS.map((col) => (
          <Fragment key={col}>
            <StatusRow
              id={col}
              cards={filteredColumns[col]}
              onCardClick={selectCard}
              onAddCard={col !== 'review' && col !== 'done' ? (column) => startNewCard(column) : undefined}
            />
            {col === 'backlog' && search.length === 0 && backlogHasMore && (
              <div className="flex justify-center py-1">
                <Button variant="outline" size="sm" onClick={loadBacklogPage} disabled={backlogLoading}>
                  {backlogLoading ? 'Loading…' : `Load more (${storeColumns.backlog.length} of ${backlogTotal})`}
                </Button>
              </div>
            )}
          </Fragment>
        ))}
      </div>
      {mounted &&
        createPortal(
          <DragOverlay dropAnimation={null}>
            {activeCard ? <CardOverlay title={activeCard.title} color={activeCard.color} /> : null}
          </DragOverlay>,
          document.body,
        )}
    </DndContext>
  );
});

export default ActiveBoard;
