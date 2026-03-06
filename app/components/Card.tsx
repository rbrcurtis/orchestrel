import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { useTRPC } from '~/lib/trpc';
import { useMutation, useQueryClient } from '@tanstack/react-query';

interface CardProps {
  id: number;
  title: string;
  onClick?: (id: number) => void;
}

export function Card({ id, title, onClick }: CardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const deleteMutation = useMutation(trpc.cards.delete.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
    },
  }));

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    touchAction: 'none' as const,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onClick?.(id)}
      className={`group relative w-full sm:w-56 sm:shrink-0 rounded bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-2 shadow-sm cursor-grab active:cursor-grabbing select-none ${isDragging ? 'opacity-40' : ''}`}
    >
      <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{title}</p>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-1 right-1 hidden group-hover:flex text-muted-foreground"
        onClick={(e) => {
          e.stopPropagation();
          if (window.confirm(`Delete "${title}"?`)) {
            deleteMutation.mutate({ id });
          }
        }}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

export function CardOverlay({ title }: { title: string }) {
  return (
    <div className="rounded bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-3 py-2 shadow-lg cursor-grabbing select-none w-full sm:w-56">
      <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{title}</p>
    </div>
  );
}
