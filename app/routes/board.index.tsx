import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useOutletContext } from 'react-router';
import { Loader2 } from 'lucide-react';
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
import { StatusRow, ALL_COLUMNS, type ColumnId } from '~/components/StatusRow';
import { CardOverlay } from '~/components/Card';

type BoardContext = {
  search: string;
  selectedCardId: number | null;
  selectCard: (id: number | null) => void;
  startNewCard: (column: string) => void;
};

const ACTIVE_COLUMNS: ColumnId[] = ['ready', 'in_progress', 'review'];

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
  promptsSent: number;
  turnsCompleted: number;
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
  for (const col of ALL_COLUMNS) {
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
  if (ACTIVE_COLUMNS.includes(id as ColumnId)) return id as ColumnId;
  for (const col of ACTIVE_COLUMNS) {
    if (columns[col].some((c) => c.id === id)) return col;
  }
  return null;
}

export default function ActiveBoard() {
  const { search, selectCard, startNewCard } = useOutletContext<BoardContext>();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: serverCards, isLoading } = useQuery(trpc.cards.list.queryOptions());

  const startClaudeMutation = useMutation(
    trpc.claude.start.mutationOptions({})
  );

  const pendingClaudeStart = useRef<{ cardId: number; prompt: string } | null>(null);

  const moveMutation = useMutation(
    trpc.cards.move.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
        if (pendingClaudeStart.current) {
          startClaudeMutation.mutate(pendingClaudeStart.current);
          pendingClaudeStart.current = null;
        }
      },
    })
  );


  const [columns, setColumns] = useState<ColumnCards>(() =>
    groupByColumn(serverCards ?? [])
  );
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const snapshotRef = useRef<ColumnCards | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Sync server data into local state when not dragging and no mutation in flight
  useEffect(() => {
    if (serverCards && !activeId && !moveMutation.isPending) {
      setColumns(groupByColumn(serverCards));
    }
  }, [serverCards, activeId, moveMutation.isPending]);

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
          if (ACTIVE_COLUMNS.includes(overId as ColumnId)) {
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
    for (const col of ACTIVE_COLUMNS) {
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

    const currentCol = findColumn(columns, active.id);
    const originalCol = snapshotRef.current
      ? findColumn(snapshotRef.current, active.id)
      : currentCol;

    if (!currentCol || !originalCol) {
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
        setColumns((prev) => ({ ...prev, [currentCol]: reordered }));

        const others = reordered.filter((c) => c.id !== active.id);
        const finalIdx = reordered.findIndex((c) => c.id === active.id);
        const pos = calcPosition(others, finalIdx);

        moveMutation.mutate({ id: active.id as number, column: currentCol, position: pos });
      }
    } else {
      // Cross-column move — handleDragOver already moved it visually, persist it
      const destCards = columns[currentCol].filter((c) => c.id !== active.id);
      const insertIdx = columns[currentCol].findIndex((c) => c.id === active.id);
      const pos = calcPosition(destCards, insertIdx === -1 ? destCards.length : insertIdx);

      moveMutation.mutate({ id: active.id as number, column: currentCol, position: pos });

      // Auto-start Claude when dragging to in_progress (after move completes)
      if (currentCol === 'in_progress') {
        const card = columns[currentCol].find((c) => c.id === active.id);
        if (card && card.repoId && card.description?.trim() && !card.sessionId) {
          pendingClaudeStart.current = { cardId: card.id, prompt: card.description.trim() };
        }
      }
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
    for (const col of ALL_COLUMNS) {
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
    for (const col of ACTIVE_COLUMNS) {
      const card = columns[col].find((c) => c.id === activeId);
      if (card) return card;
    }
    return null;
  }, [activeId, columns]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
    >
      <div className="flex flex-col gap-2 p-4">
        {ACTIVE_COLUMNS.map(col => (
          <StatusRow
            key={col}
            id={col}
            cards={filteredColumns[col]}
            onCardClick={selectCard}
            onAddCard={(column) => startNewCard(column)}
          />
        ))}
      </div>
      {mounted && createPortal(
        <DragOverlay>
          {activeCard ? (
            <CardOverlay title={activeCard.title} />
          ) : null}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  );
}
