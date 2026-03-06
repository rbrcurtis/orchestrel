import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { useTRPC } from '~/lib/trpc';
import { useMutation, useQueryClient } from '@tanstack/react-query';

const priorityColors: Record<string, string> = {
  urgent: 'border-l-red-500',
  high: 'border-l-orange-500',
  medium: 'border-l-blue-500',
  low: 'border-l-gray-300',
};

interface CardProps {
  id: number;
  title: string;
  priority: string;
  onClick?: (id: number) => void;
}

export function Card({ id, title, priority, onClick }: CardProps) {
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
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onClick?.(id)}
      className={`group relative w-56 shrink-0 rounded bg-white dark:bg-gray-800 border-l-4 ${priorityColors[priority] ?? 'border-l-gray-300'} px-3 py-2 shadow-sm cursor-grab active:cursor-grabbing select-none ${isDragging ? 'opacity-40' : ''}`}
    >
      <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{title}</p>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-1 right-1 hidden group-hover:flex text-muted-foreground"
        onClick={(e) => {
          e.stopPropagation();
          deleteMutation.mutate({ id });
        }}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

export function CardOverlay({ title, priority }: { title: string; priority: string }) {
  return (
    <div
      className={`rounded bg-white dark:bg-gray-800 border-l-4 ${priorityColors[priority] ?? 'border-l-gray-300'} px-3 py-2 shadow-lg cursor-grabbing select-none w-56`}
    >
      <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{title}</p>
    </div>
  );
}
