import { useDroppable } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { Card } from './Card';

export type ColumnId = 'backlog' | 'ready' | 'in_progress' | 'review' | 'done';

export const ALL_COLUMNS: ColumnId[] = ['backlog', 'ready', 'in_progress', 'review', 'done'];

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
        className="flex flex-wrap gap-2 px-4 pb-3 min-h-[3.5rem]"
      >
        <SortableContext items={cards.map(c => c.id)} strategy={horizontalListSortingStrategy}>
          {cards.map(card => (
            <Card key={card.id} id={card.id} title={card.title} onClick={onCardClick} />
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
