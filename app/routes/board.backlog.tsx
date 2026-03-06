import { useState, useEffect, useCallback, useMemo } from 'react';
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
  closestCenter,
  MeasuringStrategy,
  type DragStartEvent,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { StatusRow } from '~/components/StatusRow';
import { CardOverlay } from '~/components/Card';

type BoardContext = {
  search: string;
  selectedCardId: number | null;
  selectCard: (id: number | null) => void;
  startNewCard: (column: string) => void;
};

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

function calcPosition(items: { position: number }[], targetIndex: number): number {
  if (items.length === 0) return 1;
  if (targetIndex === 0) return items[0].position - 1;
  if (targetIndex >= items.length) return items[items.length - 1].position + 1;
  return (items[targetIndex - 1].position + items[targetIndex].position) / 2;
}

export default function BacklogBoard() {
  const { search, selectCard, startNewCard } = useOutletContext<BoardContext>();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: serverCards, isLoading } = useQuery(trpc.cards.list.queryOptions());

  const moveMutation = useMutation(
    trpc.cards.move.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
      },
    })
  );


  const backlogCards = useMemo(() => {
    if (!serverCards) return [];
    return serverCards
      .filter((c) => c.column === 'backlog')
      .sort((a, b) => a.position - b.position);
  }, [serverCards]);

  const [cards, setCards] = useState<CardItem[]>(backlogCards);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Sync server data into local state when not dragging and no mutation in flight
  useEffect(() => {
    if (!activeId && !moveMutation.isPending) {
      setCards(backlogCards);
    }
  }, [backlogCards, activeId, moveMutation.isPending]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(e.active.id);
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;

    if (!over) {
      setActiveId(null);
      return;
    }

    const oldIdx = cards.findIndex((c) => c.id === active.id);
    const newIdx = cards.findIndex((c) => c.id === over.id);

    if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
      const reordered = arrayMove(cards, oldIdx, newIdx);
      setCards(reordered);

      const others = reordered.filter((c) => c.id !== active.id);
      const finalIdx = reordered.findIndex((c) => c.id === active.id);
      const pos = calcPosition(others, finalIdx);

      moveMutation.mutate({ id: active.id as number, column: 'backlog', position: pos });
    }

    setActiveId(null);
  }

  function handleDragCancel() {
    setCards(backlogCards);
    setActiveId(null);
  }

  const filteredCards = useMemo(() => {
    if (!search) return cards;
    const q = search.toLowerCase();
    return cards.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.description && c.description.toLowerCase().includes(q))
    );
  }, [cards, search]);

  const activeCard = useMemo(() => {
    if (!activeId) return null;
    return cards.find((c) => c.id === activeId) ?? null;
  }, [activeId, cards]);

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
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
    >
      <div className="flex flex-col gap-2 p-4">
        <StatusRow
          id="backlog"
          cards={filteredCards}
          onCardClick={selectCard}
          onAddCard={() => startNewCard('backlog')}
        />
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
