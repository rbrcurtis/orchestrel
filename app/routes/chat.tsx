import { useState, useEffect, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { Outlet, useNavigate, useParams, Link, useLocation } from 'react-router';
import { Settings, PanelLeftClose, PanelLeft } from 'lucide-react';
import { ChatSidebar } from '~/components/ChatSidebar';
import { Button } from '~/components/ui/button';
import { useStore, useCardStore, useProjectStore } from '~/stores/context';
import SettingsProjectsModal from '~/routes/settings.projects';

const SIDEBAR_KEY = 'chat-sidebar-open';

const ChatLayout = observer(function ChatLayout() {
  const store = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const activeCardId = params.cardId ? Number(params.cardId) : null;

  const [sidebarOpen, setSidebarOpen] = useState(() => {
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
        {sidebarOpen && (
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
