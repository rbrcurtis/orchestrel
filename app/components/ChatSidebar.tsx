import { observer } from 'mobx-react-lite';
import { Link } from 'react-router';
import { Plus, MessageSquare } from 'lucide-react';
import { useCardStore, useProjectStore } from '~/stores/context';
import { ScrollArea } from '~/components/ui/scroll-area';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

type Props = {
  activeCardId: number | null;
  projectFilter: Set<number>;
  onNewChat: () => void;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const ChatSidebar = observer(function ChatSidebar({ activeCardId, projectFilter, onNewChat }: Props) {
  const cardStore = useCardStore();
  const projectStore = useProjectStore();
  const cards = cardStore.cardsByCreatedDesc.filter((card) => {
    if (projectFilter.size === 0) return true;
    return card.projectId != null && projectFilter.has(card.projectId);
  });

  return (
    <div className="flex flex-col h-full bg-sidebar text-sidebar-foreground">
      <div className="shrink-0 p-3 border-b border-sidebar-border">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 border-border hover:bg-sidebar-accent"
          onClick={onNewChat}
        >
          <Plus className="size-4" />
          New Chat
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {cards.map((card) => {
            const project = card.projectId ? projectStore.getProject(card.projectId) : null;
            const isActive = card.id === activeCardId;
            return (
              <Link
                key={card.id}
                to={`/chat/${card.id}`}
                className={cn(
                  'flex items-start gap-2 px-3 py-2.5 mx-1 rounded-md transition-colors text-sm',
                  'hover:bg-sidebar-accent',
                  isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
                  !isActive && 'text-sidebar-foreground/70',
                )}
              >
                <MessageSquare className="size-4 mt-0.5 shrink-0 text-dim" />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{card.title || 'Untitled'}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {project && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        {project.color && (
                          <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: project.color }} />
                        )}
                        <span className="truncate max-w-[80px]">{project.name}</span>
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">{timeAgo(card.createdAt)}</span>
                  </div>
                </div>
              </Link>
            );
          })}
          {cards.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {projectFilter.size > 0 ? 'No conversations match this filter' : 'No conversations yet'}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
});
