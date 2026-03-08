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
  closestCenter,
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
  projectId: number | null;
  prUrl: string | null;
  sessionId: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  promptsSent: number;
  turnsCompleted: number;
  createdAt: string;
  updatedAt: string;
  color?: string | null;
}

function calcPosition(items: { position: number }[], targetIndex: number): number {
  if (items.length === 0) return 1;
  if (targetIndex === 0) return items[0].position - 1;
  if (targetIndex >= items.length) return items[items.length - 1].position + 1;
  return (items[targetIndex - 1].position + items[targetIndex].position) / 2;
}

export default function ArchiveBoard() {
  const { search, selectCard, startNewCard } = useOutletContext<BoardContext>();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: serverCards, isLoading } = useQuery(trpc.cards.list.queryOptions());
  const { data: projectsList } = useQuery(trpc.projects.list.queryOptions());

  const colorMap = useMemo(() => {
    if (!projectsList) return {};
    const map: Record<number, string> = {};
    for (const p of projectsList) {
      if (p.color) map[p.id] = p.color;
    }
    return map;
  }, [projectsList]);

  const moveMutation = useMutation(
    trpc.cards.move.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
      },
    })
  );

  const archiveCards = useMemo(() => {
    if (!serverCards) return [];
    return serverCards
      .filter((c) => c.column === 'archive')
      .map(c => ({ ...c, color: c.projectId ? colorMap[c.projectId] ?? null : null }))
      .sort((a, b) => a.position - b.position);
  }, [serverCards, colorMap]);

  const [cards, setCards] = useState<CardItem[]>(() => archiveCards);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (archiveCards && !activeId && !moveMutation.isPending) {
      setCards(archiveCards);
    }
  }, [archiveCards, activeId, moveMutation.isPending]);

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

      moveMutation.mutate({ id: active.id as number, column: 'archive', position: pos });
    }

    setActiveId(null);
  }

  function handleDragCancel() {
    setCards(archiveCards);
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
    >
      <div className="flex flex-col gap-2 p-4">
        <StatusRow
          id="archive"
          cards={filteredCards}
          onCardClick={selectCard}
          onAddCard={() => startNewCard('archive')}
        />
      </div>
      {mounted && createPortal(
        <DragOverlay>
          {activeCard ? (
            <CardOverlay title={activeCard.title} color={activeCard.color} />
          ) : null}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  );
}
