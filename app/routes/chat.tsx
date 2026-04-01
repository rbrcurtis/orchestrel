import { useState, useEffect, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { Outlet, useNavigate, useParams, Link, useLocation } from 'react-router';
import { Settings, PanelLeftClose, PanelLeft } from 'lucide-react';
import { ChatSidebar } from '~/components/ChatSidebar';
import { Button } from '~/components/ui/button';
import { useStore } from '~/stores/context';
import SettingsProjectsModal from '~/routes/settings.projects';

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
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const activeCardId = params.cardId ? Number(params.cardId) : null;
  const isDesktop = useIsDesktop();

  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches) return false;
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

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
    <div className="h-screen flex flex-col bg-background">
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
        <h1 className="text-lg font-bold text-foreground">Orchestrel</h1>
        <nav className="flex items-center gap-1 ml-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/">Board</Link>
          </Button>
          <Button variant={location.pathname.startsWith('/chat') ? 'default' : 'ghost'} size="sm" asChild>
            <Link to="/chat">Chat</Link>
          </Button>
        </nav>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
        >
          <Settings className="size-5" />
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
            <ChatSidebar activeCardId={activeCardId} onNewChat={handleNewChat} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <Outlet />
        </div>
      </div>
      {settingsOpen && <SettingsProjectsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
});

export default ChatLayout;
