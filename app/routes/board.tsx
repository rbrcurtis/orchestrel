import { useState, useRef, useEffect, useCallback } from 'react';
import { Outlet, Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Settings } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { SearchBar } from '~/components/SearchBar';
import { ResizeHandle, useResizablePanel } from '~/components/ResizeHandle';
import { CardDetail, NewCardDetail } from '~/components/CardDetail';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '~/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';

const NAV_ITEMS = [
  { to: '/', label: 'Board' },
  { to: '/backlog', label: 'Backlog' },
  { to: '/done', label: 'Done' },
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

  const selectedCardId = searchParams.get('card') ? Number(searchParams.get('card')) : null;
  const [newCardColumn, setNewCardColumn] = useState<string | null>(null);

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
        selectCard(null);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-950">
      <header className="shrink-0 px-4 sm:px-6 py-3 border-b border-gray-200 dark:border-gray-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Conductor</h1>
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
          <Button variant="ghost" size="icon" asChild className="shrink-0 text-muted-foreground">
            <Link to="/settings/repos" title="Settings">
              <Settings className="size-5" />
            </Link>
          </Button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: rows area */}
        <div className="flex-1 overflow-y-auto" style={{ minWidth: 272 }}>
          <Outlet context={{ search, selectedCardId, selectCard, startNewCard }} />
        </div>

        {/* Resize handle (desktop only) */}
        <ResizeHandle onMouseDown={onMouseDown} />

        {/* Right: detail panel (desktop only) */}
        <div
          ref={panelRef}
          className="hidden lg:flex flex-col border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden"
          style={{ width: initialWidth }}
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

      {/* Mobile sheet (shown only on <lg when card or new-card is active) */}
      {(selectedCardId || newCardColumn) && !isDesktop && (
        <Sheet open={true} onOpenChange={() => { selectCard(null); setNewCardColumn(null); }}>
          <SheetContent side="right" className="w-full sm:w-[400px] p-0 flex flex-col" showCloseButton={false}>
            <SheetHeader className="sr-only">
              <SheetTitle>Card Detail</SheetTitle>
              <SheetDescription>Card detail panel</SheetDescription>
            </SheetHeader>
            {newCardColumn ? (
              <NewCardDetail
                column={newCardColumn}
                onCreated={(id) => selectCard(id)}
                onClose={() => setNewCardColumn(null)}
              />
            ) : selectedCardId ? (
              <CardDetail cardId={selectedCardId} onClose={() => selectCard(null)} />
            ) : null}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
