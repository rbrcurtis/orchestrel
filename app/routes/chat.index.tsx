import { useEffect, useMemo, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link } from 'react-router';
import { FolderKanban, MessageSquarePlus, Search } from 'lucide-react';
import { Input } from '~/components/ui/input';
import { ScrollArea } from '~/components/ui/scroll-area';
import { useCardStore, useProjectStore } from '~/stores/context';

const ChatIndex = observer(function ChatIndex() {
  const cardStore = useCardStore();
  const projectStore = useProjectStore();
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const projects = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projectStore.active;
    return projectStore.active.filter((project) => {
      return project.name.toLowerCase().includes(q) || project.path.toLowerCase().includes(q);
    });
  }, [projectStore.active, search]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="h-full min-h-0 overflow-hidden bg-[radial-gradient(circle_at_18%_10%,hsl(var(--primary)/0.14),transparent_24rem),radial-gradient(circle_at_82%_20%,hsl(var(--accent)/0.16),transparent_22rem)]">
      <ScrollArea className="h-full">
        <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-5 py-10 md:px-8">
          <div className="mb-10 max-w-3xl">
            <p className="mb-4 text-sm font-medium uppercase tracking-[0.4em] text-muted-foreground">Chat launchpad</p>
            <h2 className="text-4xl font-semibold tracking-tight text-foreground md:text-6xl">Where do you want to work today?</h2>
            <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
              Conversations now live inside their project. Choose a workspace, start a clean agent run, or reopen a project thread from the side rail.
            </p>
          </div>
          <div className="mb-6 w-full">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search projects by name or path…"
                className="h-14 rounded-2xl border-border/70 bg-card/80 pl-12 pr-4 text-base shadow-2xl shadow-black/10 backdrop-blur focus-visible:ring-primary/25"
              />
            </label>
          </div>
          {projects.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => {
                const cards = cardStore.cardsByCreatedDesc.filter((card) => card.projectId === project.id);
                const activeCount = cards.filter((card) => card.column === 'running' || card.column === 'review').length;
                const latest = cards[0];
                return (
                  <Link
                    key={project.id}
                    to={`/chat/${project.id}`}
                    className="group relative overflow-hidden rounded-3xl border border-border/70 bg-card/75 p-5 shadow-sm transition-all hover:-translate-y-1 hover:border-primary/40 hover:bg-card hover:shadow-2xl hover:shadow-black/20"
                  >
                    <div
                      className="absolute inset-x-0 top-0 h-1 opacity-80"
                      style={{ backgroundColor: project.color ?? 'hsl(var(--primary))' }}
                    />
                    <div className="flex items-start gap-4">
                      <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                        <FolderKanban className="size-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-lg font-semibold text-foreground">{project.name}</h3>
                        <p className="mt-1 truncate text-sm text-muted-foreground">{project.path}</p>
                      </div>
                    </div>
                    <div className="mt-8 flex items-end gap-3">
                      <div className="space-y-1 text-sm text-muted-foreground">
                        <div>{cards.length} conversation{cards.length === 1 ? '' : 's'}</div>
                        <div>{activeCount} active</div>
                      </div>
                      <span className="flex-1" />
                      <div className="flex items-center gap-2 rounded-full border border-border bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground">
                        <MessageSquarePlus className="size-3.5" />
                        New chat
                      </div>
                    </div>
                    {latest && <p className="mt-5 truncate border-t border-border/70 pt-4 text-xs text-muted-foreground">Latest: {latest.title}</p>}
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="rounded-3xl border border-dashed border-border p-10 text-center text-muted-foreground">
              {projectStore.active.length === 0
                ? 'No active projects yet. Add one in Settings, then start chatting.'
                : `No projects match “${search.trim()}”.`}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

export default ChatIndex;
