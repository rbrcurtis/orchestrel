import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Outlet, useNavigate, useParams } from 'react-router';
import { PanelLeft, PanelLeftClose, Plus } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { ChatSidebar } from '~/components/ChatSidebar';
import { useStore } from '~/stores/context';

export function meta() {
  return [{ title: 'Orc Chat' }];
}

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

function readSidebarOpen() {
  if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches) return false;
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'false';
  } catch {
    return true;
  }
}

const ChatLayout = observer(function ChatLayout() {
  const store = useStore();
  const navigate = useNavigate();
  const params = useParams();
  const activeCardId = params.cardId ? Number(params.cardId) : null;
  const projectId = params.projectId ? Number(params.projectId) : null;
  const isDesktop = useIsDesktop();
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);

  useEffect(() => {
    store.subscribe(['backlog', 'ready', 'running', 'review', 'done', 'archive']);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  function handleNewChat() {
    if (projectId == null) navigate('/chat');
    else navigate(`/chat/${projectId}`);
  }

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
        {!isDesktop && sidebarOpen && (
          <>
            <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setSidebarOpen(false)} />
            <div className="fixed top-0 left-0 bottom-0 z-40 w-64 border-r border-border bg-card">
              <ChatSidebar
                activeCardId={activeCardId}
                projectId={projectId}
                onNewChat={() => {
                  handleNewChat();
                  setSidebarOpen(false);
                }}
              />
            </div>
          </>
        )}
        {isDesktop && sidebarOpen && (
          <div className="w-64 shrink-0 border-r border-border">
            <ChatSidebar activeCardId={activeCardId} projectId={projectId} onNewChat={handleNewChat} />
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
