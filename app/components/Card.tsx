import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { useTRPC } from '~/lib/trpc';
import { useMutation, useQueryClient } from '@tanstack/react-query';

interface CardProps {
  id: number;
  title: string;
  color?: string | null;
  onClick?: (id: number) => void;
}

export function Card({ id, title, color, onClick }: CardProps) {
  const [open, setOpen] = useState(false);
  const archiveRef = useRef<HTMLButtonElement>(null);

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

  const archiveMutation = useMutation(trpc.cards.move.mutationOptions({
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
    <>
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
            setOpen(true);
          }}
        >
          <X className="size-3" />
        </Button>
      </div>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent
          onOpenAutoFocus={(e) => { e.preventDefault(); requestAnimationFrame(() => archiveRef.current?.focus()); }}
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Remove card?</AlertDialogTitle>
            <AlertDialogDescription>
              What would you like to do with "{title}"?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="ghost"
              className="border border-neon-magenta/40 bg-neon-magenta/10 text-neon-magenta hover:bg-neon-magenta/20 hover:text-neon-magenta"
              onClick={() => {
                setOpen(false);
                deleteMutation.mutate({ id });
              }}
            >
              Delete
            </Button>
            <Button
              ref={archiveRef}
              variant="ghost"
              className="border border-neon-lime/40 bg-neon-lime/10 text-neon-lime hover:bg-neon-lime/20 hover:text-neon-lime"
              onClick={() => {
                setOpen(false);
                archiveMutation.mutate({ id, column: 'archive', position: 0 });
              }}
            >
              Archive
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
