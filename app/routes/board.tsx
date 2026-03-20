import { useState, useRef, useEffect, useCallback } from 'react';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { resolvePins } from '~/lib/resolve-pin';
import { Outlet, Link, useLocation, useNavigate } from 'react-router';
import { Settings, Palette, Minus, Plus, Filter, X } from 'lucide-react';
import { ProjectPinSelector } from '~/components/ProjectPinSelector';
import { ScrollArea } from '~/components/ui/scroll-area';
import { Button } from '~/components/ui/button';
import { SearchBar } from '~/components/SearchBar';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { Checkbox } from '~/components/ui/checkbox';
import { ResizeHandle, useResizablePanel } from '~/components/ResizeHandle';
import { CardDetail, NewCardDetail } from '~/components/CardDetail';
import IconsModal from '~/routes/icons';
import SettingsProjectsModal from '~/routes/settings.projects';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select';
import { useStore, useCardStore, useProjectStore } from '~/stores/context';

const NAV_ITEMS = [
  { to: '/', label: 'Board' },
  { to: '/archive', label: 'Archive' },
] as const;

const MIN_COLUMN_WIDTH = 350;
const COLUMN_COUNT_KEY = 'dispatcher-column-count';
const COLUMN_SLOTS_KEY = 'dispatcher-column-slots';
const COLUMN_PINS_KEY = 'dispatcher-column-pins';

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
  const [projectFilter, setProjectFilter] = useState<Set<number>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const { panelRef, initialWidth, onMouseDown } = useResizablePanel();
  const isDesktop = useIsDesktop();

  const store = useStore();
  const cardStore = useCardStore();
  const projectStore = useProjectStore();

  useEffect(() => {
    store.subscribe(['backlog', 'ready', 'running', 'review', 'done', 'archive']);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-column state (persisted to localStorage)
  const [columnCount, setColumnCount] = useState(() => readLocalStorage(COLUMN_COUNT_KEY, 1));
  const [columnSlots, setColumnSlots] = useState<(number | null)[]>(() => readLocalStorage(COLUMN_SLOTS_KEY, [null]));
  const [columnPins, setColumnPins] = useState<(number | null)[]>(() => readLocalStorage(COLUMN_PINS_KEY, [null]));
  const [newCardColumn, setNewCardColumn] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<'icons' | 'settings' | null>(null);

  const maxColumns = useMaxColumns(panelRef);

  // Keep columnSlots length in sync with columnCount
  useEffect(() => {
    setColumnSlots((prev) => {
      if (prev.length === columnCount) return prev;
      if (prev.length < columnCount) {
        const next = [...prev, ...(Array(columnCount - prev.length).fill(null) as null[])];
        writeLocalStorage(COLUMN_SLOTS_KEY, next);
        return next;
      }
      const next = prev.slice(0, columnCount);
      writeLocalStorage(COLUMN_SLOTS_KEY, next);
      return next;
    });
  }, [columnCount]);

  // Keep columnPins length in sync with columnCount
  useEffect(() => {
    setColumnPins((prev) => {
      if (prev.length === columnCount) return prev;
      if (prev.length < columnCount) {
        const next = [...prev, ...(Array(columnCount - prev.length).fill(null) as null[])];
        writeLocalStorage(COLUMN_PINS_KEY, next);
        return next;
      }
      const next = prev.slice(0, columnCount);
      writeLocalStorage(COLUMN_PINS_KEY, next);
      return next;
    });
  }, [columnCount]);

  // Clamp columnCount if maxColumns shrinks below it
  useEffect(() => {
    if (columnCount > maxColumns) {
      setColumnCount(maxColumns);
      writeLocalStorage(COLUMN_COUNT_KEY, maxColumns);
    }
  }, [maxColumns]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist slots to localStorage whenever they change
  const updateSlots = useCallback((updater: (prev: (number | null)[]) => (number | null)[]) => {
    setColumnSlots((prev) => {
      const next = updater(prev);
      writeLocalStorage(COLUMN_SLOTS_KEY, next);
      return next;
    });
  }, []);

  const updatePins = useCallback((updater: (prev: (number | null)[]) => (number | null)[]) => {
    setColumnPins((prev) => {
      const next = updater(prev);
      writeLocalStorage(COLUMN_PINS_KEY, next);
      return next;
    });
  }, []);

  // Evict cards that no longer exist (deleted)
  useEffect(() => {
    updateSlots((prev) => {
      let changed = false;
      const next = prev.map((id) => {
        if (id == null) return null;
        const card = cardStore.getCard(id);
        if (!card) {
          changed = true;
          return null;
        }
        return id;
      });
      return changed ? next : prev;
    });
  }); // runs every render — MobX observer tracks card changes

  // Resolve pinned slots — MobX reaction tracks card store changes
  useEffect(() => {
    const dispose = reaction(
      () => {
        const allCards = Array.from(cardStore.cards.values());
        return { allCards, pins: columnPins };
      },
      ({ allCards, pins }) => {
        const hasPins = pins.some((p) => p != null);
        if (!hasPins) return;

        const resolved = resolvePins(allCards, pins);

        updateSlots((prev) => {
          let changed = false;
          const next = [...prev];
          for (let i = 0; i < next.length; i++) {
            if (pins[i] == null) continue;
            if (next[i] !== resolved[i]) {
              if (resolved[i] != null) {
                setFlashSlot(i);
              }
              next[i] = resolved[i];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { fireImmediately: true },
    );
    return dispose;
  }, [columnPins]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mobile: track which single card is open for overlay
  const [mobileCardId, setMobileCardId] = useState<number | null>(null);
  const [mobileFlash, setMobileFlash] = useState(false);

  // Flash: which slot index should show the "already open" overlay
  const [flashSlot, setFlashSlot] = useState<number | null>(null);

  function selectCard(id: number | null) {
    setNewCardColumn(null);
    if (!isDesktop) {
      if (id != null && mobileCardId === id) {
        // Already open on mobile — flash it
        setMobileFlash(true);
        return;
      }
      setMobileCardId(id);
      return;
    }
    if (id === null) return;
    // Desktop: place in next open unpinned slot, or slot 0 if all full
    updateSlots((prev) => {
      const existingIdx = prev.indexOf(id);
      if (existingIdx >= 0) {
        // Already open — flash that slot
        setFlashSlot(existingIdx);
        return prev;
      }
      const next = [...prev];
      const emptyIdx = next.findIndex((slot, i) => slot === null && columnPins[i] == null);
      next[emptyIdx >= 0 ? emptyIdx : 0] = id;
      return next;
    });
  }

  function closeSlot(index: number) {
    updateSlots((prev) => {
      const next = [...prev];
      next[index] = null;
      return next;
    });
    updatePins((prev) => {
      if (prev[index] == null) return prev;
      const next = [...prev];
      next[index] = null;
      return next;
    });
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

  function pinSlot(index: number, projectId: number) {
    if (index === 0) return; // slot 0 is the hotseat, never pinnable
    updatePins((prev) => {
      const next = [...prev];
      next[index] = projectId;
      return next;
    });
  }

  // Keyboard shortcuts
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
        } else if (!isDesktop) {
          setMobileCardId(null);
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, isDesktop]);

  // For outlet context: selectedCardId is still passed for backwards compat (slot 0)
  const selectedCardId = columnSlots[0] ?? null;

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="shrink-0 px-8 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
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
        </div>
        <div className="flex items-center gap-3 flex-1 min-w-0 justify-end">
          <SearchBar ref={searchRef} value={search} onChange={setSearch} />

          {/* Project filter */}
          {projectStore.all.length > 0 && (
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
                  {projectStore.all.map((p) => (
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
                        <span
                          className="size-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: `var(--${p.color})` }}
                        />
                      )}
                      <span className="text-sm truncate">{p.name}</span>
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

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
            onClick={() => setActiveModal('icons')}
            title="Icon Colors"
          >
            <Palette className="size-5" />
          </Button>
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

      <div className="flex-1 flex overflow-hidden">
        {/* Left: rows area */}
        <ScrollArea className="flex-1" style={{ minWidth: 272 }}>
          <Outlet
            context={{ search, projectFilter, selectedCardId, selectCard, startNewCard, updateSlots, columnSlots }}
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
                      style={{ backgroundColor: clr ? `var(--${clr})` : 'white' }}
                      onAnimationEnd={() => setMobileFlash(false)}
                    />
                  );
                })()}
              {newCardColumn ? (
                <NewCardDetail
                  column={newCardColumn}
                  onCreated={(id) => {
                    setNewCardColumn(null);
                    setMobileCardId(id);
                  }}
                  onClose={() => setNewCardColumn(null)}
                />
              ) : mobileCardId != null ? (
                <CardDetail cardId={mobileCardId} onClose={() => setMobileCardId(null)} />
              ) : null}
            </div>
          </>
        )}

        {/* Desktop: multi-column card panels */}
        <div ref={panelRef} className="hidden lg:flex overflow-hidden" style={{ width: initialWidth }}>
          {columnSlots.map((cardId, idx) => {
            const pinProject = columnPins[idx] != null ? projectStore.getProject(columnPins[idx]!) : null;
            const slotCard = cardId != null ? cardStore.getCard(cardId) : undefined;
            const slotProject = slotCard?.projectId ? projectStore.getProject(slotCard.projectId) : null;
            const borderColor = pinProject?.color ?? slotProject?.color ?? null;
            return (
              <ColumnSlot
                key={idx}
                index={idx}
                cardId={cardId}
                borderColor={borderColor}
                flash={flashSlot === idx}
                onFlashDone={() => setFlashSlot(null)}
                newCardColumn={newCardColumn}
                updateSlots={updateSlots}
                updatePins={updatePins}
                pinProjectId={columnPins[idx] ?? null}
                onPin={(projectId) => pinSlot(idx, projectId)}
                setNewCardColumn={setNewCardColumn}
                closeSlot={closeSlot}
              />
            );
          })}
        </div>
      </div>

      {activeModal === 'icons' && <IconsModal onClose={() => setActiveModal(null)} />}
      {activeModal === 'settings' && <SettingsProjectsModal onClose={() => setActiveModal(null)} />}
    </div>
  );
});

type ColumnSlotProps = {
  index: number;
  cardId: number | null;
  borderColor: string | null;
  flash: boolean;
  onFlashDone: () => void;
  newCardColumn: string | null;
  updateSlots: (updater: (prev: (number | null)[]) => (number | null)[]) => void;
  updatePins: (updater: (prev: (number | null)[]) => (number | null)[]) => void;
  pinProjectId: number | null;
  onPin: (projectId: number) => void;
  setNewCardColumn: (col: string | null) => void;
  closeSlot: (index: number) => void;
};

const ColumnSlot = observer(function ColumnSlot({
  index,
  cardId,
  borderColor,
  flash,
  onFlashDone,
  newCardColumn,
  updateSlots,
  updatePins,
  pinProjectId,
  onPin,
  setNewCardColumn,
  closeSlot,
}: ColumnSlotProps) {
  const projectStore = useProjectStore();
  const [dragOver, setDragOver] = useState(false);
  const [draftColor, setDraftColor] = useState<string | null>(null);

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

    // Column-to-column header drag
    const slotData = e.dataTransfer.getData('application/x-card-slot');
    if (slotData) {
      const { cardId: srcCardId, slotIndex: srcIdx } = JSON.parse(slotData) as { cardId: number; slotIndex: number };
      if (srcIdx === index) return;
      updateSlots((prev) => {
        const next = [...prev];
        next[srcIdx] = null; // source slot becomes empty
        next[index] = srcCardId; // target slot gets the dragged card (replaces whatever was there)
        return next;
      });
      // Clear pin on target slot only — source pin stays so resolver can refill it
      updatePins((prev) => {
        if (prev[index] == null) return prev;
        const next = [...prev];
        next[index] = null;
        return next;
      });
      return;
    }

    // Kanban card drag
    const kanbanData = e.dataTransfer.getData('application/x-kanban-card');
    if (kanbanData) {
      const { cardId: draggedId } = JSON.parse(kanbanData) as { cardId: number };
      updateSlots((prev) => {
        const next = [...prev];
        // Remove from any existing slot to avoid duplicates
        for (let i = 0; i < next.length; i++) {
          if (next[i] === draggedId) next[i] = null;
        }
        next[index] = draggedId;
        return next;
      });
      updatePins((prev) => {
        if (prev[index] == null) return prev;
        const next = [...prev];
        next[index] = null;
        return next;
      });
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
            style={c ? { backgroundColor: `var(--${c})` } : undefined}
          />
        );
      })()}
      <div className="relative flex flex-col flex-1 min-w-0 bg-card overflow-hidden">
        {flash && (
          <div
            className="absolute inset-0 z-10 pointer-events-none animate-slot-flash"
            style={{ backgroundColor: borderColor ? `var(--${borderColor})` : 'white' }}
            onAnimationEnd={onFlashDone}
          />
        )}
        {newCardColumn && index === 0 ? (
          <NewCardDetail
            column={newCardColumn}
            onCreated={(id) => {
              setDraftColor(null);
              setNewCardColumn(null);
              updateSlots((prev) => {
                const next = [...prev];
                next[0] = id;
                return next;
              });
            }}
            onClose={() => {
              setDraftColor(null);
              setNewCardColumn(null);
            }}
            onColorChange={setDraftColor}
          />
        ) : cardId != null ? (
          <CardDetail cardId={cardId} onClose={() => closeSlot(index)} slotIndex={index} />
        ) : pinProjectId != null ? (
          <div className="flex flex-col flex-1">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-sm font-medium text-muted-foreground truncate">
                {projectStore.getProject(pinProjectId)?.name ?? 'Unknown project'}
              </span>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => closeSlot(index)}>
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
