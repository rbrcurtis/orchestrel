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
import { useCardStore } from '~/stores/context';

interface CardProps {
  id: number;
  title: string;
  color?: string | null;
  /** Epoch ms set by /sleep: the card waits in ready until then. */
  sleepUntil?: number | null;
  /** Prompt the waker sends when that time arrives. */
  sleepPrompt?: string | null;
  onClick?: (id: number) => void;
}

/** "asleep until 17:22" for today, with a weekday for later days. */
function sleepLabel(until: number): string {
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `asleep until ${time}`;
  return `asleep until ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

export function Card({ id, title, color, sleepUntil, sleepPrompt, onClick }: CardProps) {
  const [open, setOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [archivePending, setArchivePending] = useState(false);
  const archiveRef = useRef<HTMLButtonElement>(null);
  const cards = useCardStore();

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition: isDragging ? 'none' : transition,
    touchAction: 'none' as const,
    opacity: isDragging ? 0 : 1,
    ...(color ? { borderLeftColor: color } : {}),
  };

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        onClick={() => onClick?.(id)}
        className={`group relative rounded bg-card border border-border px-3 py-2 shadow-sm cursor-grab active:cursor-grabbing select-none ${color ? 'border-l-3' : ''}`}
      >
        <div className="flex items-center gap-1">
          <p className="text-sm text-foreground truncate flex-1 min-w-0 self-center">{title}</p>
          <button
            type="button"
            className="shrink-0 flex sm:invisible sm:group-hover:visible items-center px-1 -my-2 -mr-3 rounded-r text-muted-foreground/60 hover:text-neon-magenta hover:bg-neon-magenta/10 active:bg-neon-magenta/20"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
          >
            <X className="size-3.5" />
          </button>
        </div>
        {sleepUntil ? (
          <p className="text-[10px] text-muted-foreground/80 truncate">
            {sleepLabel(sleepUntil)}
            {sleepPrompt ? <span className="text-muted-foreground/60"> · {sleepPrompt}</span> : null}
          </p>
        ) : null}
      </div>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            requestAnimationFrame(() => archiveRef.current?.focus());
          }}
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Remove card?</AlertDialogTitle>
            <AlertDialogDescription>What would you like to do with "{title}"?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="ghost"
              className="border border-neon-magenta/40 bg-neon-magenta/10 text-neon-magenta hover:bg-neon-magenta/20 hover:text-neon-magenta"
              disabled={deletePending}
              onClick={async () => {
                setDeletePending(true);
                try {
                  await cards.deleteCard(id);
                } finally {
                  setDeletePending(false);
                  setOpen(false);
                }
              }}
            >
              Delete
            </Button>
            <Button
              ref={archiveRef}
              variant="ghost"
              className="border border-neon-lime/40 bg-neon-lime/10 text-neon-lime hover:bg-neon-lime/20 hover:text-neon-lime"
              disabled={archivePending}
              onClick={async () => {
                setArchivePending(true);
                try {
                  await cards.updateCard({ id, column: 'archive', position: 0 });
                } finally {
                  setArchivePending(false);
                  setOpen(false);
                }
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
      className={`rounded bg-card border border-border px-3 py-2 shadow-lg cursor-grabbing select-none ${color ? 'border-l-3' : ''}`}
      style={color ? { borderLeftColor: color } : undefined}
    >
      <p className="text-sm text-foreground truncate">{title}</p>
    </div>
  );
}
