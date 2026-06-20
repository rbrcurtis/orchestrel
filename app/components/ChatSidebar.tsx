import { observer } from 'mobx-react-lite';
import { Link } from 'react-router';
import { MessageSquare, Plus } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { ScrollArea } from '~/components/ui/scroll-area';
import { cn } from '~/lib/utils';
import { useCardStore, useProjectStore } from '~/stores/context';

type Props = {
  activeCardId: number | null;
  projectId: number | null;
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

export const ChatSidebar = observer(function ChatSidebar({ activeCardId, projectId, onNewChat }: Props) {
  const cardStore = useCardStore();
  const projectStore = useProjectStore();
  const project = projectId == null ? null : projectStore.getProject(projectId);
  const cards = projectId == null ? [] : cardStore.cardsByUpdatedDesc.filter((card) => card.projectId === projectId);

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="shrink-0 space-y-3 border-b border-sidebar-border p-3">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 border-border hover:bg-sidebar-accent"
          onClick={onNewChat}
          disabled={!project}
        >
          <Plus className="size-4" />
          New chat
        </Button>
        {project ? (
          <div className="rounded-xl bg-sidebar-accent/50 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {project.color && <span className="size-2 rounded-full" style={{ backgroundColor: project.color }} />}
              <span className="truncate">{project.name}</span>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{project.path}</div>
          </div>
        ) : (
          <div className="px-2 text-xs leading-5 text-muted-foreground">Select a project to see its conversations.</div>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {cards.map((card) => {
            const isActive = card.id === activeCardId;
            return (
              <Link
                key={card.id}
                to={`/chat/${projectId}/${card.id}`}
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
                  <div className="mt-0.5 text-xs text-muted-foreground">{timeAgo(card.createdAt)}</div>
                </div>
              </Link>
            );
          })}
          {project && cards.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">No conversations in this project yet</div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
});
