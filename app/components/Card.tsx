import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { useTRPC } from '~/lib/trpc';
import { useMutation, useQueryClient } from '@tanstack/react-query';

interface CardProps {
  id: number;
  title: string;
  color?: string | null;
  onClick?: (id: number) => void;
}

export function Card({ id, title, color, onClick }: CardProps) {
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
    transition: isDragging ? 'none' : transition,
    touchAction: 'none' as const,
    opacity: isDragging ? 0 : 1,
    ...(color ? { borderLeftColor: `var(--${color})` } : {}),
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onClick?.(id)}
      className={`group relative w-full sm:w-56 sm:shrink-0 rounded bg-card border border-border px-3 py-2 shadow-sm cursor-grab active:cursor-grabbing select-none ${color ? 'border-l-3' : ''}`}
    >
      <p className="text-sm text-foreground truncate">{title}</p>
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

export function CardOverlay({ title, color }: { title: string; color?: string | null }) {
  return (
    <div
      className={`rounded bg-card border border-border px-3 py-2 shadow-lg cursor-grabbing select-none w-full sm:w-56 ${color ? 'border-l-3' : ''}`}
      style={color ? { borderLeftColor: `var(--${color})` } : undefined}
    >
      <p className="text-sm text-foreground truncate">{title}</p>
    </div>
  );
}
