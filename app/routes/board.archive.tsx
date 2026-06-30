import { useState, useMemo, useEffect } from 'react';
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
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { useCardStore, useProjectStore } from '~/stores/context';
import { StatusRow } from '~/components/StatusRow';
import { CardOverlay } from '~/components/Card';
import type { Card } from '../../src/shared/ws-protocol';

type BoardContext = {
  search: string;
  projectFilter: Set<number>;
  selectedCardId: number | null;
  selectCard: (id: number | null) => void;
  startNewCard: (column: string) => void;
  updateSlots: (updater: (prev: (number | null)[]) => (number | null)[]) => void;
  columnSlots: (number | null)[];
};

interface CardItem extends Card {
  color?: string | null;
}

function calcPosition(items: { position: number }[], targetIndex: number): number {
  if (items.length === 0) return 1;
  if (targetIndex === 0) return items[0].position - 1;
  if (targetIndex >= items.length) return items[items.length - 1].position + 1;
  return (items[targetIndex - 1].position + items[targetIndex].position) / 2;
}

const ArchiveBoard = observer(function ArchiveBoard() {
  const { search, projectFilter, selectCard } = useOutletContext<BoardContext>();
  const cardStore = useCardStore();
  const projectStore = useProjectStore();

  const colorMap = useMemo(() => {
    const map: Record<number, string> = {};
    for (const p of projectStore.all) {
      if (p.color) map[p.id] = p.color;
    }
    return map;
  }, [projectStore.all]);

  // Archive is lazy-loaded (not part of the board subscribe). Page it in here.
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  // Derive the cursor from the OLDEST archive card already in the store (matching
  // the server's updatedAt DESC, id DESC order) rather than tracking a page cursor.
  // The store can be pre-filled from IndexedDB persistence or live-merged cards, so
  // a fixed page-1 cursor would re-fetch already-loaded pages; the tail self-heals.
  function loadNextPage() {
    if (loading) return;
    const loaded = cardStore.cardsByColumn('archive');
    let tail: { id: number; updatedAt: string } | undefined;
    for (const c of loaded) {
      if (!tail || c.updatedAt < tail.updatedAt || (c.updatedAt === tail.updatedAt && c.id < tail.id)) {
        tail = c;
      }
    }
    setLoading(true);
    cardStore
      .loadPage('archive', tail?.id)
      .then((r) => {
        setTotal(r.total);
        setHasMore(r.nextCursor !== undefined);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadNextPage();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // With pagination only a slice of archive is loaded, so a typed query must hit
  // the server to search the whole archive (debounced); results merge into the store.
  useEffect(() => {
    if (search.length === 0) return;
    const t = setTimeout(() => void cardStore.search(search), 250);
    return () => clearTimeout(t);
  }, [search, cardStore]);

  // Read archive cards from store. Computed inline (not memoized) so the mobx
  // observer tracks the map reads and re-renders when paged cards are merged in —
  // cardStore.cards is a stable ObservableMap, so a useMemo keyed on it never
  // recomputes and the list would freeze at the first page.
  const storeCards: CardItem[] = cardStore.cardsByColumn('archive').map((c) => ({
    ...c,
    color: c.projectId ? (colorMap[c.projectId] ?? null) : null,
  }));

  // Local override during drag only
  const [dragOverride, setDragOverride] = useState<CardItem[] | null>(null);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [mounted] = useState(true);

  const cards = dragOverride ?? storeCards;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(e.active.id);
    setDragOverride([...storeCards]);
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;

    if (!over) {
      setActiveId(null);
      setDragOverride(null);
      return;
    }

    const oldIdx = cards.findIndex((c) => c.id === active.id);
    const newIdx = cards.findIndex((c) => c.id === over.id);

    if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
      const reordered = arrayMove(cards, oldIdx, newIdx);
      setDragOverride(reordered);

      const others = reordered.filter((c) => c.id !== active.id);
      const finalIdx = reordered.findIndex((c) => c.id === active.id);
      const pos = calcPosition(others, finalIdx);

      cardStore
        .updateCard({ id: active.id as number, column: 'archive', position: pos })
        .finally(() => setDragOverride(null));
    } else {
      setDragOverride(null);
    }

    setActiveId(null);
  }

  function handleDragCancel() {
    setDragOverride(null);
    setActiveId(null);
  }

  const filteredCards = useMemo(() => {
    const hasSearch = search.length > 0;
    const hasProject = projectFilter.size > 0;
    if (!hasSearch && !hasProject) return cards;
    const q = search.toLowerCase();
    return cards.filter((c) => {
      if (hasProject && !projectFilter.has(c.projectId ?? -1)) return false;
      if (
        hasSearch &&
        !c.title.toLowerCase().includes(q) &&
        !(c.description && c.description.toLowerCase().includes(q))
      )
        return false;
      return true;
    });
  }, [cards, search, projectFilter]);

  const activeCard = useMemo(() => {
    if (!activeId) return null;
    return cards.find((c) => c.id === activeId) ?? null;
  }, [activeId, cards]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex flex-col gap-2 p-4">
        <StatusRow id="archive" cards={filteredCards} onCardClick={selectCard} />
        {search.length === 0 && hasMore && (
          <div className="flex justify-center py-2">
            <Button variant="outline" size="sm" onClick={loadNextPage} disabled={loading}>
              {loading ? 'Loading…' : `Load more (${storeCards.length} of ${total})`}
            </Button>
          </div>
        )}
      </div>
      {mounted &&
        createPortal(
          <DragOverlay>
            {activeCard ? <CardOverlay title={activeCard.title} color={activeCard.color} /> : null}
          </DragOverlay>,
          document.body,
        )}
    </DndContext>
  );
});

export default ArchiveBoard;
