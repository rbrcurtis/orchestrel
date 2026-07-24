import { Button } from '~/components/ui/button';

export function SharedDraftNotice({ count, onOpen, onDiscard }: { count: number; onOpen: () => void; onDiscard: () => void }) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted p-2 text-xs">
      <span className="flex-1">{count} shared {count === 1 ? 'draft is' : 'drafts are'} waiting</span>
      <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>Discard</Button>
      <Button type="button" size="sm" onClick={onOpen}>Open shared draft</Button>
    </div>
  );
}
