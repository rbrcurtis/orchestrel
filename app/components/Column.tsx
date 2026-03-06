import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
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

export const COLUMNS: ColumnId[] = ['backlog', 'ready', 'in_progress', 'review', 'done'];

interface CardItem {
  id: number;
  title: string;
  priority: string;
  position: number;
}

interface ColumnProps {
  id: ColumnId;
  cards: CardItem[];
  onCardClick?: (id: number) => void;
  onAddCard?: (column: ColumnId) => void;
}

export function Column({ id, cards, onCardClick, onAddCard }: ColumnProps) {
  const { setNodeRef } = useDroppable({ id });

  return (
    <div className="w-72 shrink-0 flex flex-col bg-gray-100 dark:bg-gray-900 rounded-lg">
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {displayNames[id]}
        </h2>
        <div className="flex items-center gap-1">
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
      </div>
      <div
        ref={setNodeRef}
        className="flex flex-col gap-2 px-2 pb-2 min-h-[2rem] flex-1"
      >
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <Card key={card.id} id={card.id} title={card.title} priority={card.priority} onClick={onCardClick} />
          ))}
        </SortableContext>
        {cards.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-gray-600 text-center py-4">
            No cards
          </p>
        )}
      </div>
    </div>
  );
}
