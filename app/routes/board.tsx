import { useState, useRef, useEffect, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { useSlots } from '~/lib/use-slots';
import type { SlotState, PinTarget } from '~/lib/resolve-pin';
import { Outlet, Link, useLocation, useNavigate } from 'react-router';
import { Settings, Minus, Plus, Filter, X } from 'lucide-react';
import { ProjectPinSelector } from '~/components/ProjectPinSelector';
import { ScrollArea } from '~/components/ui/scroll-area';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { SearchBar } from '~/components/SearchBar';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { Checkbox } from '~/components/ui/checkbox';
import { ResizeHandle, useResizablePanel } from '~/components/ResizeHandle';
import { CardDetail, NewCardDetail } from '~/components/CardDetail';
import SettingsProjectsModal from '~/routes/settings.projects';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { useStore, useCardStore, useProjectStore } from '~/stores/context';
import { dispatchTypeFocus, isTypeFocusKey, isTypingContext } from '~/lib/type-focus';
import type { Card, Column } from '../../src/shared/ws-protocol';

const NAV_ITEMS = [
  { to: '/', label: 'Board' },
  { to: '/archive', label: 'Archive' },
] as const;

const MIN_COLUMN_WIDTH = 350;
const COLUMN_COUNT_KEY = 'dispatcher-column-count';
const PROJECT_FILTER_KEY = 'dispatcher-project-filter';

function readLocalStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalStorage<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

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

function useMaxColumns(panelRef: React.RefObject<HTMLDivElement | null>) {
  const [max, setMax] = useState(() => {
    // Compute synchronously from DOM if available so the first render
    // already knows the real max — prevents clamping a restored count.
    if (panelRef.current) {
      const w = panelRef.current.getBoundingClientRect().width;
      return Math.max(1, Math.floor(w / MIN_COLUMN_WIDTH));
    }
    // SSR / ref not yet attached — use window width as best guess
    if (typeof window !== 'undefined') {
      return Math.max(1, Math.floor(window.innerWidth / MIN_COLUMN_WIDTH));
    }
    return 4;
  });
  useEffect(() => {
    function compute() {
      if (!panelRef.current) return;
      const w = panelRef.current.getBoundingClientRect().width;
      setMax(Math.max(1, Math.floor(w / MIN_COLUMN_WIDTH)));
    }
    compute();
    const obs = new ResizeObserver(compute);
    if (panelRef.current) obs.observe(panelRef.current);
    return () => obs.disconnect();
  }, [panelRef]);
  return max;
}

const BoardLayout = observer(function BoardLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const section = location.pathname === '/archive' ? 'archive' : 'board';
  const [projectFilter, _setProjectFilter] = useState<Set<number>>(
    () => new Set(readLocalStorage<number[]>(PROJECT_FILTER_KEY, [])),
  );
  const setProjectFilter = useCallback((update: Set<number> | ((prev: Set<number>) => Set<number>)) => {
    _setProjectFilter((prev) => {
      const next = typeof update === 'function' ? update(prev) : update;
      writeLocalStorage(PROJECT_FILTER_KEY, [...next]);
      return next;
    });
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const { panelRef, initialWidth, onMouseDown } = useResizablePanel();
  const isDesktop = useIsDesktop();

  const store = useStore();
  const cardStore = useCardStore();
  const projectStore = useProjectStore();

  useEffect(() => {
    // Backlog and archive are intentionally excluded: both can grow long, and
    // bulk-loading them bloats the store and slows every live update. Each is
    // lazy-paged by its route (board.index.tsx pages backlog 50 at a time;
    // board.archive.tsx pages archive). A card that moves into backlog/archive
    // still arrives live because card:updated is emitted to its old column room
    // too, and onCardUpdated merges it into the store regardless of subscription.
    store.subscribe(['ready', 'running', 'review', 'done']);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSearch('');
  }, [section]);

  // Multi-column state (persisted to localStorage)
  const [columnCount, setColumnCount] = useState(() => readLocalStorage(COLUMN_COUNT_KEY, 1));
  const [newCardColumn, setNewCardColumn] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<'settings' | null>(null);

  const maxColumns = useMaxColumns(panelRef);
  const [focusedCardId, setFocusedCardId] = useState<number | null>(null);
  // Last card whose prompt had focus — the "focused session" for type-to-focus.
  const lastPromptCardRef = useRef<number | null>(null);
  const [promptFocusRequest, setPromptFocusRequest] = useState<{ cardId: number; seq: number } | null>(null);
  const promptFocusSeq = useRef(0);
  // After a send, the wheel may rotate (the presentation effect below focuses
  // the new card) or keep the same card — remember the sent card so the
  // same-card case can refocus its prompt once the server's update lands.
  const pendingSentRef = useRef<{ cardId: number; card: Card } | null>(null);

  const allCards = Array.from(cardStore.cards.values());
  const {
    slots: columnSlots,
    resolvedCards,
    pinSlot,
    closeSlot,
    releaseHotseat,
    unpinSlot,
    selectCard: hookSelectCard,
    dropCard,
    onCardCreated,
    flashSlot,
    clearFlash: clearFlashSlot,
  } = useSlots(columnCount, allCards, projectFilter, focusedCardId);

  // Clamp columnCount if maxColumns shrinks below it
  useEffect(() => {
    if (columnCount > maxColumns) {
      setColumnCount(maxColumns);
      writeLocalStorage(COLUMN_COUNT_KEY, maxColumns);
    }
  }, [maxColumns]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mobile: track which single card is open for overlay
  const [mobileCardId, setMobileCardId] = useState<number | null>(null);
  const [mobileFlash, setMobileFlash] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const cardId = (e as CustomEvent<{ cardId: number }>).detail.cardId;
      selectCard(cardId);
    };
    window.addEventListener('orchestrel:focus-card', handler);
    return () => window.removeEventListener('orchestrel:focus-card', handler);
  }); // intentionally no deps — selectCard is a local function that closes over current state

  useEffect(() => {
    const handler = (e: Event) => {
      const cardId = (e as CustomEvent<{ cardId: number }>).detail.cardId;
      const card = cardStore.getCard(cardId);
      if (card) pendingSentRef.current = { cardId, card };
    };
    window.addEventListener('orchestrel:prompt-sent', handler);
    return () => window.removeEventListener('orchestrel:prompt-sent', handler);
  }, [cardStore]);

  useEffect(() => {
    const onFocus = (e: Event) => {
      const cardId = (e as CustomEvent<{ cardId: number }>).detail.cardId;
      lastPromptCardRef.current = cardId;
      setFocusedCardId(cardId);
    };
    const onBlur = () => setFocusedCardId(null);
    window.addEventListener('orchestrel:prompt-focus', onFocus);
    window.addEventListener('orchestrel:prompt-blur', onBlur);
    return () => {
      window.removeEventListener('orchestrel:prompt-focus', onFocus);
      window.removeEventListener('orchestrel:prompt-blur', onBlur);
    };
  }, []);

  // Ferris wheel: when a slot presents a new card and the user isn't typing
  // anywhere, focus the new card's prompt so they can type immediately.
  const prevPresentedRef = useRef<Map<number, number> | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally no deps, resolvedCards is a fresh Map each render
  useEffect(() => {
    const prev = prevPresentedRef.current;
    prevPresentedRef.current = resolvedCards;
    if (prev == null) return; // initial mount — nothing presented yet
    if (focusedCardId != null) return; // user is typing in a prompt
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable)
    ) {
      return; // user is typing somewhere else (search, card composer, etc.)
    }
    for (const [idx, cardId] of resolvedCards) {
      if (prev.get(idx) !== cardId) {
        promptFocusSeq.current += 1;
        setPromptFocusRequest({ cardId, seq: promptFocusSeq.current });
        pendingSentRef.current = null;
        return;
      }
    }
    // No rotation: a prompt was just sent and the server's card update has
    // landed (the store holds a new object), so the wheel's chance to rotate
    // has passed — refocus the same card's prompt.
    const pending = pendingSentRef.current;
    if (pending == null) return;
    const current = cardStore.getCard(pending.cardId);
    if (current == null) {
      pendingSentRef.current = null;
      return;
    }
    if (current === pending.card) return; // server echo not here yet
    pendingSentRef.current = null;
    for (const [, cardId] of resolvedCards) {
      if (cardId === pending.cardId) {
        promptFocusSeq.current += 1;
        setPromptFocusRequest({ cardId: pending.cardId, seq: promptFocusSeq.current });
        return;
      }
    }
  });

  function selectCard(id: number | null, opts?: { focusPrompt?: boolean }) {
    setNewCardColumn(null);
    if (!isDesktop) {
      if (id != null && mobileCardId === id) {
        setMobileFlash(true);
        return;
      }
      setMobileCardId(id);
      return;
    }
    if (id === null) return;
    if (opts?.focusPrompt) {
      promptFocusSeq.current += 1;
      setPromptFocusRequest({ cardId: id, seq: promptFocusSeq.current });
    }
    hookSelectCard(id);
  }

  function startNewCard(column: string) {
    if (!isDesktop) {
      setMobileCardId(null);
    }
    setNewCardColumn(column);
  }

  function addColumn() {
    if (columnCount >= maxColumns) return;
    const next = columnCount + 1;
    setColumnCount(next);
    writeLocalStorage(COLUMN_COUNT_KEY, next);
  }

  function removeColumn() {
    if (columnCount <= 1) return;
    const next = columnCount - 1;
    setColumnCount(next);
    writeLocalStorage(COLUMN_COUNT_KEY, next);
  }

  // Keyboard shortcuts
  useEffect(() => {
    // Cards currently presented in a slot (or the mobile overlay) — only these
    // have a mounted prompt that type-to-focus can land on.
    const displayedCardIds = new Set<number>();
    columnSlots.forEach((slot, idx) => {
      const id =
        slot.type === 'manual'
          ? slot.cardId
          : (resolvedCards.get(idx) ?? (slot.type === 'pinned' ? (slot.cardId ?? null) : null));
      if (id != null) displayedCardIds.add(id);
    });
    if (mobileCardId != null) displayedCardIds.add(mobileCardId);

    const slot0 = columnSlots[0];
    const hotseatId =
      slot0?.type === 'manual'
        ? slot0.cardId
        : (resolvedCards.get(0) ?? (slot0?.type === 'pinned' ? (slot0.cardId ?? null) : null));

    function handleKeyDown(e: KeyboardEvent) {
      if (e.repeat) return;

      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'n') {
          e.preventDefault();
          setNewCardColumn('backlog');
          return;
        }
        // Ctrl+A/Ctrl+D (Control only — Cmd+A must keep select-all on Mac):
        // move the focused card to archive/done and re-enter the ferris
        // wheel. Works from inside the prompt textarea, so it runs before
        // the typing-context early return below.
        if (e.ctrlKey && !e.metaKey && (key === 'a' || key === 'd')) {
          const column = (key === 'a' ? 'archive' : 'done') as Column;
          let id = focusedCardId;
          if (id == null || !displayedCardIds.has(id)) id = lastPromptCardRef.current;
          if (id == null || !displayedCardIds.has(id)) id = hotseatId;
          if (id == null || !displayedCardIds.has(id)) return;
          const card = cardStore.getCard(id);
          if (!card || card.column === column) return;
          e.preventDefault();
          void cardStore.updateCard({ id, column });
          // Release the slot holding the card so the resolver rotates to the
          // next review/running card.
          for (let i = 0; i < columnSlots.length; i++) {
            const slot = columnSlots[i];
            const displayed =
              slot.type === 'manual'
                ? slot.cardId
                : (resolvedCards.get(i) ?? (slot.type === 'pinned' ? (slot.cardId ?? null) : null));
            if (displayed !== id) continue;
            if (i === 0) releaseHotseat();
            else closeSlot(i);
            break;
          }
          // Drop the focus lock and blur the prompt so the wheel's
          // presentation effect can focus the next card's prompt.
          setFocusedCardId(null);
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          return;
        }
      }

      const target = e.target instanceof HTMLElement ? e.target : null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

      if (isTypeFocusKey(e) && !isTypingContext(e.target)) {
        let id = lastPromptCardRef.current;
        if (id == null || !displayedCardIds.has(id)) id = hotseatId;
        if (id != null && displayedCardIds.has(id)) {
          e.preventDefault();
          dispatchTypeFocus(id, e.key);
        }
        return;
      }

      if (e.key === '?') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        if (activeModal) {
          setActiveModal(null);
        } else if (!isDesktop) {
          setMobileCardId(null);
        } else if (columnSlots[0]?.type === 'manual' || resolvedCards.has(0)) {
          releaseHotseat();
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, isDesktop, columnSlots, resolvedCards, releaseHotseat, closeSlot, setNewCardColumn, mobileCardId, focusedCardId, cardStore]);

  // For outlet context: selectedCardId is still passed for backwards compat (slot 0)
  const selectedCardId = columnSlots[0]?.type === 'manual' ? columnSlots[0].cardId : null;

  return (
    <div className="h-dvh overflow-hidden flex flex-col bg-background">
      <header className="shrink-0 px-3 sm:px-8 py-3 border-b border-border flex flex-nowrap items-center justify-between gap-2 sm:gap-3">
        <div className="flex flex-1 min-w-0 items-center gap-2 sm:gap-4">
          <h1 className="text-xl font-bold text-foreground hidden sm:block">Orchestrel</h1>
          {/* Mobile: dropdown nav */}
          <Select value={location.pathname} onValueChange={(v) => navigate(v)}>
            <SelectTrigger size="sm" className="sm:hidden">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NAV_ITEMS.map(({ to, label }) => (
                <SelectItem key={to} value={to}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Desktop: button nav */}
          <nav className="hidden sm:flex items-center gap-1">
            {NAV_ITEMS.map(({ to, label }) => (
              <Button key={to} variant={location.pathname === to ? 'default' : 'ghost'} size="sm" asChild>
                <Link to={to}>{label}</Link>
              </Button>
            ))}
          </nav>
          <SearchBar ref={searchRef} value={search} onChange={setSearch} />
          {/* Project filter */}
          {(section === 'archive' ? projectStore.all : projectStore.active).length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`shrink-0 relative ${projectFilter.size > 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                  title="Filter by project"
                >
                  <Filter className="size-4" />
                  {projectFilter.size > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 size-4 rounded-full bg-primary text-primary-foreground text-[10px] font-medium flex items-center justify-center">
                      {projectFilter.size}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-52 p-2">
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
                  {(section === 'archive' ? projectStore.all : projectStore.active).map((p) => (
                    <label
                      key={p.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-accent cursor-pointer"
                    >
                      <Checkbox
                        checked={projectFilter.has(p.id)}
                        onCheckedChange={(checked) => {
                          setProjectFilter((prev) => {
                            const next = new Set(prev);
                            if (checked) next.add(p.id);
                            else next.delete(p.id);
                            return next;
                          });
                        }}
                      />
                      {p.color && (
                        <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                      )}
                      <span className="text-sm truncate">{p.name}</span>
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
        <div className="flex items-center gap-3 min-w-0">
          {/* Column count stepper (desktop only) */}
          <div className="hidden lg:flex items-center gap-1 text-muted-foreground">
            <span className="text-xs mr-1">Columns</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={removeColumn}
              disabled={columnCount <= 1}
              title="Remove column"
            >
              <Minus className="size-3.5" />
            </Button>
            <span className="text-xs w-4 text-center tabular-nums">{columnCount}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={addColumn}
              disabled={columnCount >= maxColumns}
              title="Add column"
            >
              <Plus className="size-3.5" />
            </Button>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground"
            onClick={() => setActiveModal('settings')}
            title="Settings"
          >
            <Settings className="size-5" />
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left: rows area */}
        <ScrollArea className="flex-1 min-h-0" style={{ minWidth: 272 }}>
          <Outlet
            context={{
              search,
              projectFilter,
              selectedCardId,
              selectCard: (id: number | null) => {
                if (section === 'board' && id !== null && search.length > 0) setSearch('');
                selectCard(id, { focusPrompt: true });
              },
              startNewCard,
              dropCard,
              onCardCreated,
              slots: columnSlots,
            }}
          />
        </ScrollArea>

        {/* Resize handle (desktop only) */}
        <ResizeHandle onMouseDown={onMouseDown} />

        {/* Mobile: backdrop + single-card overlay */}
        {!isDesktop && (mobileCardId != null || newCardColumn != null) && (
          <>
            <div
              className="fixed inset-0 z-30 bg-black/50"
              onClick={() => {
                setMobileCardId(null);
                setNewCardColumn(null);
              }}
            />
            <div className="fixed top-0 right-0 bottom-0 z-40 w-full sm:w-[400px] flex flex-col border-l border-border bg-card overflow-hidden">
              {mobileFlash &&
                (() => {
                  const mc = mobileCardId != null ? cardStore.getCard(mobileCardId) : undefined;
                  const mp = mc?.projectId ? projectStore.getProject(mc.projectId) : null;
                  const clr = mp?.color;
                  return (
                    <div
                      className="absolute inset-0 z-10 pointer-events-none animate-slot-flash"
                      style={{ backgroundColor: clr ?? 'white' }}
                      onAnimationEnd={() => setMobileFlash(false)}
                    />
                  );
                })()}
              {newCardColumn ? (
                <NewCardDetail
                  column={newCardColumn}
                  projectFilter={projectFilter}
                  onCreated={(id, _projectId) => {
                    setNewCardColumn(null);
                    setMobileCardId(id);
                  }}
                  onClose={() => setNewCardColumn(null)}
                />
              ) : mobileCardId != null ? (
                <CardDetail
                  cardId={mobileCardId}
                  onClose={() => setMobileCardId(null)}
                  onPromptSent={() => releaseHotseat()}
                />
              ) : null}
            </div>
          </>
        )}

        {/* Desktop: multi-column card panels */}
        <div ref={panelRef} className="hidden lg:flex overflow-hidden" style={{ width: initialWidth }}>
          {columnSlots.map((slot, idx) => {
            const pinProjectId = slot.type === 'pinned' ? slot.projectId : null;
            const displayedCardId =
              slot.type === 'manual'
                ? slot.cardId
                : slot.type === 'pinned'
                  ? (resolvedCards.get(idx) ?? slot.cardId ?? null)
                  : (resolvedCards.get(idx) ?? null);
            const slotCard = displayedCardId != null ? cardStore.getCard(displayedCardId) : undefined;
            const slotProject = slotCard?.projectId ? projectStore.getProject(slotCard.projectId) : null;
            const pinProject = typeof pinProjectId === 'number' ? projectStore.getProject(pinProjectId) : null;
            const borderColor =
              pinProjectId === 'all' ? (slotProject?.color ?? null) : (pinProject?.color ?? slotProject?.color ?? null);
            return (
              <ColumnSlot
                key={idx}
                index={idx}
                slot={slot}
                cardId={displayedCardId}
                borderColor={borderColor}
                flash={flashSlot === idx}
                onFlashDone={clearFlashSlot}
                newCardColumn={newCardColumn}
                projectFilter={projectFilter}
                dropCard={dropCard}
                pinProjectId={pinProjectId}
                onPin={(projectId) => pinSlot(idx, projectId)}
                setNewCardColumn={setNewCardColumn}
                closeSlot={closeSlot}
                unpinSlot={unpinSlot}
                onCardCreated={onCardCreated}
                promptFocusSeq={
                  displayedCardId != null && promptFocusRequest?.cardId === displayedCardId
                    ? promptFocusRequest.seq
                    : null
                }
              />
            );
          })}
        </div>
      </div>

      {activeModal === 'settings' && <SettingsProjectsModal onClose={() => setActiveModal(null)} />}
    </div>
  );
});

type ColumnSlotProps = {
  index: number;
  slot: SlotState;
  cardId: number | null;
  borderColor: string | null;
  flash: boolean;
  onFlashDone: () => void;
  newCardColumn: string | null;
  projectFilter: Set<number>;
  dropCard: (slotIndex: number, cardId: number, cardProjectId: number | null) => void;
  pinProjectId: PinTarget | null;
  onPin: (projectId: PinTarget) => void;
  setNewCardColumn: (col: string | null) => void;
  closeSlot: (index: number) => void;
  unpinSlot: (index: number) => void;
  onCardCreated: (cardId: number, projectId: number | null) => void;
  promptFocusSeq: number | null;
};

const ColumnSlot = observer(function ColumnSlot({
  index,
  slot: _slot,
  cardId,
  borderColor,
  flash,
  onFlashDone,
  newCardColumn,
  projectFilter,
  dropCard,
  pinProjectId,
  onPin,
  setNewCardColumn,
  closeSlot,
  unpinSlot,
  onCardCreated,
  promptFocusSeq,
}: ColumnSlotProps) {
  const cardStore = useCardStore();
  const projectStore = useProjectStore();
  const [dragOver, setDragOver] = useState(false);
  const [draftColor, setDraftColor] = useState<string | null>(null);
  const [creatingCard, setCreatingCard] = useState(false);

  function handleDragOver(e: React.DragEvent) {
    // Accept drops from column headers and kanban cards
    if (
      e.dataTransfer.types.includes('application/x-card-slot') ||
      e.dataTransfer.types.includes('application/x-kanban-card')
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOver(true);
    }
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    setCreatingCard(false);
    const slotData = e.dataTransfer.getData('application/x-card-slot');
    if (slotData) {
      const { cardId: srcCardId, slotIndex: srcIdx } = JSON.parse(slotData) as { cardId: number; slotIndex: number };
      if (srcIdx === index) return;
      const srcCard = cardStore.getCard(srcCardId);
      dropCard(index, srcCardId, srcCard?.projectId ?? null);
      return;
    }
    const kanbanData = e.dataTransfer.getData('application/x-kanban-card');
    if (kanbanData) {
      const { cardId: draggedId } = JSON.parse(kanbanData) as { cardId: number };
      const draggedCard = cardStore.getCard(draggedId);
      dropCard(index, draggedId, draggedCard?.projectId ?? null);
    }
  }

  return (
    <div
      data-column-slot={index}
      className={`flex flex-1 min-w-0 overflow-hidden transition-opacity ${dragOver ? 'ring-2 ring-inset ring-neon-cyan/50' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Column divider — project-colored like ResizeHandle */}
      {(() => {
        const c = newCardColumn && index === 0 ? draftColor : borderColor;
        return (
          <div
            className={`w-1 shrink-0 transition-colors ${c ? '' : 'bg-border'}`}
            style={c ? { backgroundColor: c } : undefined}
          />
        );
      })()}
      <div className="relative flex flex-col flex-1 min-w-0 bg-card overflow-hidden">
        {flash && (
          <div
            className="absolute inset-0 z-10 pointer-events-none animate-slot-flash"
            style={{ backgroundColor: borderColor ?? 'white' }}
            onAnimationEnd={onFlashDone}
          />
        )}
        {newCardColumn && index === 0 ? (
          <NewCardDetail
            column={newCardColumn}
            projectFilter={projectFilter}
            onCreated={(id, projectId) => {
              setDraftColor(null);
              setNewCardColumn(null);
              onCardCreated(id, projectId);
            }}
            onClose={() => {
              setDraftColor(null);
              setNewCardColumn(null);
            }}
            onColorChange={setDraftColor}
          />
        ) : creatingCard && typeof pinProjectId === 'number' ? (
          <NewCardDetail
            column="running"
            initialProjectId={pinProjectId}
            projectFilter={projectFilter}
            onCreated={(id, projectId) => {
              setCreatingCard(false);
              setDraftColor(null);
              onCardCreated(id, projectId);
            }}
            onClose={() => {
              setCreatingCard(false);
              setDraftColor(null);
            }}
            onColorChange={setDraftColor}
          />
        ) : cardId != null ? (
          <CardDetail
            cardId={cardId}
            onClose={() => (pinProjectId != null ? unpinSlot(index) : closeSlot(index))}
            clearSlot={() => closeSlot(index)}
            slotIndex={index}
            pinned={pinProjectId != null}
            promptFocusSeq={promptFocusSeq}
          />
        ) : pinProjectId != null ? (
          <div className="flex flex-col flex-1">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
              {typeof pinProjectId === 'number' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 shrink-0"
                  onClick={() => setCreatingCard(true)}
                >
                  <Plus className="size-4" />
                </Button>
              )}
              <span className="flex-1" />
              {pinProjectId === 'all' ? (
                <Badge variant="secondary" className="text-xs shrink-0">
                  <span
                    className="inline-block size-2 rounded-full mr-1.5"
                    style={{
                      background: 'conic-gradient(from 0deg, #ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444)',
                    }}
                  />
                  All Projects
                </Badge>
              ) : (
                (() => {
                  const p = projectStore.getProject(pinProjectId);
                  return p ? (
                    <Badge
                      variant="secondary"
                      className={`text-xs shrink-0 ${p.color ? 'animate-review-glow' : ''}`}
                      style={{
                        ...(p.color ? { borderLeft: `3px solid ${p.color}` } : {}),
                        ...(p.color ? ({ '--glow-color': p.color } as React.CSSProperties) : {}),
                      }}
                    >
                      {p.name}
                    </Badge>
                  ) : null;
                })()
              )}
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => unpinSlot(index)}>
                <X className="size-4" />
              </Button>
            </div>
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              No review or running cards
            </div>
          </div>
        ) : index === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Select a card</div>
        ) : (
          <ProjectPinSelector onSelect={onPin} />
        )}
      </div>
    </div>
  );
});

export default BoardLayout;
