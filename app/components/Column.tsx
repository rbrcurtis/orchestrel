import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useState } from 'react';
import { Card } from './Card';
import { AddCardForm } from './AddCardForm';

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
}

export function Column({ id, cards, onCardClick }: ColumnProps) {
  const { setNodeRef } = useDroppable({ id });
  const [isAdding, setIsAdding] = useState(false);

  return (
    <div className="w-72 shrink-0 flex flex-col bg-gray-100 dark:bg-gray-900 rounded-lg">
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {displayNames[id]}
        </h2>
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500 bg-gray-200 dark:bg-gray-700 rounded-full px-2 py-0.5">
            {cards.length}
          </span>
          <button
            onClick={() => setIsAdding(true)}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-lg leading-none"
            title="Add card"
          >
            +
          </button>
        </div>
      </div>
      {isAdding && <AddCardForm column={id} onClose={() => setIsAdding(false)} />}
      <div
        ref={setNodeRef}
        className="flex flex-col gap-2 px-2 pb-2 min-h-[2rem] flex-1"
      >
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <Card key={card.id} id={card.id} title={card.title} priority={card.priority} onClick={onCardClick} />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}
