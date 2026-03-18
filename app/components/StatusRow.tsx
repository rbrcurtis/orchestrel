import { useState, useCallback } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { ChevronRight, Plus } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '~/components/ui/collapsible';
import { Card } from './Card';

export type ColumnId = 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'archive';

export const ALL_COLUMNS: ColumnId[] = ['backlog', 'ready', 'running', 'review', 'done', 'archive'];

const COLLAPSIBLE_COLUMNS: Set<ColumnId> = new Set(['backlog', 'ready', 'done']);

const displayNames: Record<ColumnId, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  running: 'Running',
  review: 'Review',
  done: 'Done',
  archive: 'Archive',
};

function getCollapsedKey(id: ColumnId) {
  return `dispatcher:collapsed:${id}`;
}

function readCollapsed(id: ColumnId): boolean {
  try {
    return localStorage.getItem(getCollapsedKey(id)) === '1';
  } catch {
    return false;
  }
}

interface CardItem {
  id: number;
  title: string;
  position: number;
  color?: string | null;
  queuePosition?: number | null;
}

interface StatusRowProps {
  id: ColumnId;
  cards: CardItem[];
  onCardClick?: (id: number) => void;
  onAddCard?: (column: ColumnId) => void;
}

export function StatusRow({ id, cards, onCardClick, onAddCard }: StatusRowProps) {
  const { setNodeRef } = useDroppable({ id });
  const collapsible = COLLAPSIBLE_COLUMNS.has(id);
  const [collapsed, setCollapsed] = useState(() => collapsible && readCollapsed(id));

  const toggle = useCallback(
    (open: boolean) => {
      const next = !open;
      setCollapsed(next);
      try {
        if (next) localStorage.setItem(getCollapsedKey(id), '1');
        else localStorage.removeItem(getCollapsedKey(id));
      } catch {
        /* ignore */
      }
    },
    [id],
  );

  const cardList = (
    <div ref={setNodeRef} className="flex flex-wrap gap-2 px-4 pb-3 min-h-[3.5rem]">
      <SortableContext items={cards.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
        {cards.map((card) => (
          <Card
            key={card.id}
            id={card.id}
            title={card.title}
            color={card.color}
            queuePosition={card.queuePosition}
            onClick={onCardClick}
          />
        ))}
      </SortableContext>
      {cards.length === 0 && <p className="text-xs text-muted-foreground py-2">No cards</p>}
    </div>
  );

  const header = (
    <div className="flex items-center gap-2 px-4 py-2">
      {collapsible && (
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon-xs" className="size-5">
            <ChevronRight className={`size-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          </Button>
        </CollapsibleTrigger>
      )}
      <h2 className="text-sm font-semibold text-muted-foreground">{displayNames[id]}</h2>
      <Badge variant="secondary">{cards.length}</Badge>
      <Button variant="ghost" size="icon-xs" onClick={() => onAddCard?.(id)} title="Add card">
        <Plus className="size-4" />
      </Button>
    </div>
  );

  if (!collapsible) {
    return (
      <div className="shrink-0">
        {header}
        {cardList}
      </div>
    );
  }

  return (
    <Collapsible open={!collapsed} onOpenChange={toggle} className="shrink-0">
      {header}
      <CollapsibleContent>{cardList}</CollapsibleContent>
    </Collapsible>
  );
}
