import { useState, useRef, useEffect, useCallback } from 'react';
import { Outlet, Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Settings, Palette } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { SearchBar } from '~/components/SearchBar';
import { ResizeHandle, useResizablePanel } from '~/components/ResizeHandle';
import { CardDetail, NewCardDetail } from '~/components/CardDetail';
import IconsModal from '~/routes/icons';
import SettingsProjectsModal from '~/routes/settings.projects';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { useTRPC } from '~/lib/trpc';
import { useQuery } from '@tanstack/react-query';

const NAV_ITEMS = [
  { to: '/', label: 'Board' },
  { to: '/backlog', label: 'Backlog' },
  { to: '/archive', label: 'Archive' },
] as const;

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

export default function BoardLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const { panelRef, initialWidth, onMouseDown } = useResizablePanel();
  const isDesktop = useIsDesktop();

  const trpc = useTRPC();
  const { data: allCards } = useQuery(trpc.cards.list.queryOptions());
  const { data: projectsList } = useQuery(trpc.projects.list.queryOptions());

  const selectedCardId = searchParams.get('card') ? Number(searchParams.get('card')) : null;
  const [newCardColumn, setNewCardColumn] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<'icons' | 'settings' | null>(null);

  // Derive divider color from selected card's project
  const selectedCard = allCards?.find(c => c.id === selectedCardId);
  const selectedProject = selectedCard?.projectId
    ? projectsList?.find(p => p.id === selectedCard.projectId)
    : null;
  const dividerColor = selectedCardId ? (selectedProject?.color ?? null) : null;
  const panelActive = !!(selectedCardId || newCardColumn);

  function selectCard(id: number | null) {
    setNewCardColumn(null);
    setSearchParams(prev => {
      if (id === null) {
        prev.delete('card');
      } else {
        prev.set('card', String(id));
      }
      return prev;
    }, { replace: true });
  }

  function startNewCard(column: string) {
    selectCard(null);
    setNewCardColumn(column);
  }

  // Keyboard shortcuts (layout-level)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        if (activeModal) {
          setActiveModal(null);
        } else {
          selectCard(null);
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeModal]);

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="shrink-0 px-4 sm:px-6 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-foreground">Dispatcher</h1>
          {/* Mobile: dropdown nav */}
          <Select value={location.pathname} onValueChange={(v) => navigate(v)}>
            <SelectTrigger size="sm" className="sm:hidden">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NAV_ITEMS.map(({ to, label }) => (
                <SelectItem key={to} value={to}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Desktop: button nav */}
          <nav className="hidden sm:flex items-center gap-1">
            {NAV_ITEMS.map(({ to, label }) => (
              <Button
                key={to}
                variant={location.pathname === to ? 'default' : 'ghost'}
                size="sm"
                asChild
              >
                <Link to={to}>{label}</Link>
              </Button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 flex-1 min-w-0 justify-end">
          <SearchBar ref={searchRef} value={search} onChange={setSearch} />
          <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" onClick={() => setActiveModal('icons')} title="Icon Colors">
            <Palette className="size-5" />
          </Button>
          <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" onClick={() => setActiveModal('settings')} title="Settings">
            <Settings className="size-5" />
          </Button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: rows area */}
        <div className="flex-1 overflow-y-auto" style={{ minWidth: 272 }}>
          <Outlet context={{ search, selectedCardId, selectCard, startNewCard }} />
        </div>

        {/* Resize handle (desktop only) */}
        <ResizeHandle onMouseDown={onMouseDown} color={dividerColor} />

        {/* Backdrop for mobile panel */}
        {panelActive && (
          <div
            className="fixed inset-0 z-30 bg-black/50 lg:hidden"
            onClick={() => { selectCard(null); setNewCardColumn(null); }}
          />
        )}

        {/* Detail panel — inline on desktop, fixed overlay on mobile */}
        <div
          ref={panelRef}
          className={[
            'flex flex-col border-l border-border bg-card overflow-hidden',
            panelActive
              ? 'fixed top-0 right-0 bottom-0 z-40 w-full sm:w-[400px] lg:static lg:z-auto'
              : 'hidden lg:flex',
          ].join(' ')}
          style={isDesktop ? { width: initialWidth } : undefined}
        >
          {newCardColumn ? (
            <NewCardDetail
              column={newCardColumn}
              onCreated={(id) => selectCard(id)}
              onClose={() => setNewCardColumn(null)}
            />
          ) : selectedCardId ? (
            <CardDetail cardId={selectedCardId} onClose={() => selectCard(null)} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Select a card to view details
            </div>
          )}
        </div>
      </div>

      {activeModal === 'icons' && <IconsModal onClose={() => setActiveModal(null)} />}
      {activeModal === 'settings' && <SettingsProjectsModal onClose={() => setActiveModal(null)} />}
    </div>
  );
}
