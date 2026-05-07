import { useState, useEffect, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { Outlet, useNavigate, useParams } from 'react-router';
import { Filter, PanelLeftClose, PanelLeft, Plus } from 'lucide-react';
import { ChatSidebar } from '~/components/ChatSidebar';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { useStore, useProjectStore } from '~/stores/context';

const SIDEBAR_KEY = 'chat-sidebar-open';

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isDesktop;
}

const ChatLayout = observer(function ChatLayout() {
  const store = useStore();
  const projectStore = useProjectStore();
  const navigate = useNavigate();
  const params = useParams();
  const activeCardId = params.cardId ? Number(params.cardId) : null;
  const isDesktop = useIsDesktop();
  const [projectFilter, setProjectFilter] = useState<Set<number>>(() => new Set());

  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches) return false;
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    store.subscribe(['backlog', 'ready', 'running', 'review', 'done', 'archive']);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes sidebar on mobile
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape' && !isDesktop) setSidebarOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isDesktop]);

  function toggleSidebar() {
    setSidebarOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(SIDEBAR_KEY, String(next));
      } catch {
        /* noop */
      }
      return next;
    });
  }

  const handleNewChat = useCallback(() => {
    navigate('/chat');
  }, [navigate]);

  return (
    <div className="h-dvh max-h-dvh flex flex-col overflow-hidden bg-background">
      <header className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground"
          onClick={toggleSidebar}
          title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
        >
          {sidebarOpen ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
        </Button>
        <h1 className="text-lg font-bold text-foreground">Orchestrel Chat</h1>
        <span className="flex-1" />
        {projectStore.all.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant={projectFilter.size > 0 ? 'default' : 'ghost'}
                size="icon"
                className={`shrink-0 relative ${projectFilter.size > 0 ? 'shadow-[0_0_18px_hsl(var(--primary)/0.35)]' : 'text-muted-foreground'}`}
                title="Filter by project"
                aria-label="Filter by project"
              >
                <Filter className="size-4" />
                {projectFilter.size > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 size-4 rounded-full bg-primary text-primary-foreground text-[10px] font-medium flex items-center justify-center">
                    {projectFilter.size}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-2">
              <div className="flex items-center justify-between px-2 pb-2">
                <span className="text-xs font-medium text-muted-foreground">Projects</span>
                {projectFilter.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto py-0.5 px-1.5 text-xs text-muted-foreground"
                    onClick={() => setProjectFilter(new Set())}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-0.5">
                {projectStore.all.map((project) => (
                  <label
                    key={project.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-accent cursor-pointer"
                  >
                    <Checkbox
                      checked={projectFilter.has(project.id)}
                      onCheckedChange={(checked) => {
                        setProjectFilter((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(project.id);
                          else next.delete(project.id);
                          return next;
                        });
                      }}
                    />
                    {project.color && (
                      <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: project.color }} />
                    )}
                    <span className="text-sm truncate">{project.name}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          onClick={handleNewChat}
          title="New Session"
          aria-label="New Session"
        >
          <Plus className="size-4" />
        </Button>
      </header>
      <div className="flex-1 flex overflow-hidden">
        {/* Mobile: overlay sidebar */}
        {!isDesktop && sidebarOpen && (
          <>
            <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setSidebarOpen(false)} />
            <div className="fixed top-0 left-0 bottom-0 z-40 w-64 border-r border-border bg-card">
              <ChatSidebar
                activeCardId={activeCardId}
                projectFilter={projectFilter}
                onNewChat={() => {
                  handleNewChat();
                  setSidebarOpen(false);
                }}
              />
            </div>
          </>
        )}
        {/* Desktop: inline sidebar */}
        {isDesktop && sidebarOpen && (
          <div className="w-64 shrink-0 border-r border-border">
            <ChatSidebar activeCardId={activeCardId} projectFilter={projectFilter} onNewChat={handleNewChat} />
          </div>
        )}
        <div className="flex-1 min-w-0 overflow-hidden">
          <Outlet />
        </div>
      </div>
    </div>
  );
});

export default ChatLayout;
