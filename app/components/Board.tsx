import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
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
  type DragOverEvent,
  type DragEndEvent,
  type CollisionDetection,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Column, COLUMNS, type ColumnId } from './Column';
import { CardOverlay } from './Card';
import { SearchBar } from './SearchBar';
import { CardDetailPanel } from './CardDetailPanel';

interface CardItem {
  id: number;
  title: string;
  description: string | null;
  column: string;
  position: number;
  priority: string;
  repoId: number | null;
  prUrl: string | null;
  sessionId: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

type ColumnCards = Record<ColumnId, CardItem[]>;

function groupByColumn(items: CardItem[]): ColumnCards {
  const groups: ColumnCards = {
    backlog: [],
    ready: [],
    in_progress: [],
    review: [],
    done: [],
  };
  for (const card of items) {
    const col = card.column as ColumnId;
    if (groups[col]) groups[col].push(card);
  }
  for (const col of COLUMNS) {
    groups[col].sort((a, b) => a.position - b.position);
  }
  return groups;
}

function calcPosition(items: { position: number }[], targetIndex: number): number {
  if (items.length === 0) return 1;
  if (targetIndex === 0) return items[0].position - 1;
  if (targetIndex >= items.length) return items[items.length - 1].position + 1;
  return (items[targetIndex - 1].position + items[targetIndex].position) / 2;
}

function findColumn(columns: ColumnCards, id: UniqueIdentifier): ColumnId | null {
  // Check if id is a column id itself
  if (COLUMNS.includes(id as ColumnId)) return id as ColumnId;
  // Otherwise find which column contains the card
  for (const col of COLUMNS) {
    if (columns[col].some((c) => c.id === id)) return col;
  }
  return null;
}

export function Board() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: serverCards } = useQuery(trpc.cards.list.queryOptions());

  const moveMutation = useMutation(
    trpc.cards.move.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
      },
    })
  );

  const [columns, setColumns] = useState<ColumnCards>(() =>
    groupByColumn(serverCards ?? [])
  );
  const [search, setSearch] = useState('');
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const snapshotRef = useRef<ColumnCards | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Sync server data into local state when not dragging
  useEffect(() => {
    if (serverCards && !activeId) {
      setColumns(groupByColumn(serverCards));
    }
  }, [serverCards, activeId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const lastOverId = useRef<UniqueIdentifier | null>(null);

  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      // First try pointerWithin
      const pwCollisions = pointerWithin(args);
      if (pwCollisions.length > 0) {
        const overId = getFirstCollision(pwCollisions, 'id');
        lastOverId.current = overId;
        if (overId != null) {
          // If over a column, find the closest card within it
          if (COLUMNS.includes(overId as ColumnId)) {
            const colCards = columns[overId as ColumnId];
            if (colCards.length > 0) {
              const closestInCol = closestCenter({
                ...args,
                droppableContainers: args.droppableContainers.filter(
                  (c) => c.id === overId || colCards.some((card) => card.id === c.id)
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
    [columns]
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(e.active.id);
    snapshotRef.current = { ...columns };
    for (const col of COLUMNS) {
      snapshotRef.current[col] = [...columns[col]];
    }
  }

  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;

    const activeCol = findColumn(columns, active.id);
    const overCol = findColumn(columns, over.id);

    if (!activeCol || !overCol || activeCol === overCol) return;

    setColumns((prev) => {
      const sourceCards = [...prev[activeCol]];
      const destCards = [...prev[overCol]];

      const activeIdx = sourceCards.findIndex((c) => c.id === active.id);
      if (activeIdx === -1) return prev;

      const [moved] = sourceCards.splice(activeIdx, 1);

      // Find insertion index in destination
      const overIdx = destCards.findIndex((c) => c.id === over.id);
      const insertIdx = overIdx === -1 ? destCards.length : overIdx;

      destCards.splice(insertIdx, 0, { ...moved, column: overCol });

      return { ...prev, [activeCol]: sourceCards, [overCol]: destCards };
    });
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;

    if (!over) {
      setActiveId(null);
      snapshotRef.current = null;
      return;
    }

    const activeCol = findColumn(columns, active.id);
    const overCol = findColumn(columns, over.id);

    if (!activeCol || !overCol) {
      setActiveId(null);
      snapshotRef.current = null;
      return;
    }

    // If same column, handle reorder
    if (activeCol === overCol) {
      const colCards = columns[activeCol];
      const oldIdx = colCards.findIndex((c) => c.id === active.id);
      const newIdx = colCards.findIndex((c) => c.id === over.id);

      if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
        const reordered = arrayMove(colCards, oldIdx, newIdx);
        setColumns((prev) => ({ ...prev, [activeCol]: reordered }));

        // Calculate position based on neighbors in reordered array
        const others = reordered.filter((c) => c.id !== active.id);
        const finalIdx = reordered.findIndex((c) => c.id === active.id);
        const pos = calcPosition(others, finalIdx);

        moveMutation.mutate({ id: active.id as number, column: activeCol, position: pos });
      }
    } else {
      // Cross-column move already happened in onDragOver, just persist
      const destCards = columns[overCol].filter((c) => c.id !== active.id);
      const insertIdx = columns[overCol].findIndex((c) => c.id === active.id);
      const pos = calcPosition(destCards, insertIdx === -1 ? destCards.length : insertIdx);

      moveMutation.mutate({ id: active.id as number, column: overCol, position: pos });
    }

    setActiveId(null);
    snapshotRef.current = null;
  }

  function handleDragCancel() {
    if (snapshotRef.current) {
      setColumns(snapshotRef.current);
    }
    setActiveId(null);
    snapshotRef.current = null;
  }

  const filteredColumns = useMemo(() => {
    if (!search) return columns;
    const q = search.toLowerCase();
    const result = {} as ColumnCards;
    for (const col of COLUMNS) {
      result[col] = columns[col].filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          (c.description && c.description.toLowerCase().includes(q))
      );
    }
    return result;
  }, [columns, search]);

  const activeCard = useMemo(() => {
    if (!activeId) return null;
    for (const col of COLUMNS) {
      const card = columns[col].find((c) => c.id === activeId);
      if (card) return card;
    }
    return null;
  }, [activeId, columns]);

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-950">
      <header className="shrink-0 px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Dispatch</h1>
        <SearchBar value={search} onChange={setSearch} />
      </header>
      <div className="flex-1 overflow-x-auto p-4">
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        >
          <div className="flex gap-4 h-full">
            {COLUMNS.map((col) => (
              <Column key={col} id={col} cards={filteredColumns[col]} onCardClick={setSelectedCardId} />
            ))}
          </div>
          {mounted &&
            createPortal(
              <DragOverlay>
                {activeCard ? (
                  <CardOverlay title={activeCard.title} priority={activeCard.priority} />
                ) : null}
              </DragOverlay>,
              document.body
            )}
        </DndContext>
      </div>
      {selectedCardId !== null && (
        <CardDetailPanel
          cardId={selectedCardId}
          onClose={() => setSelectedCardId(null)}
        />
      )}
    </div>
  );
}
