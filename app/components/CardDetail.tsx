import { useState, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { X, ChevronDown, ChevronRight, Copy, Check, GitBranch } from 'lucide-react';
import { useCardStore, useProjectStore, useSessionStore } from '~/stores/context';
import { SessionView } from './SessionView';
import { InlineEdit } from './InlineEdit';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectSeparator, SelectValue } from '~/components/ui/select';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Checkbox } from '~/components/ui/checkbox';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '~/components/ui/collapsible';
import { cn } from '~/lib/utils';
import type { Column } from '../../src/shared/ws-protocol';

type Props = {
  cardId: number;
  onClose: () => void;
  slotIndex?: number;
};

const STATUSES = ['backlog', 'ready', 'running', 'review', 'done', 'archive'] as const;
const statusLabels: Record<string, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  running: 'Running',
  review: 'Review',
  done: 'Done',
  archive: 'Archive',
};

type Draft = {
  title: string;
  description: string;
  projectId: number | null;
  useWorktree: boolean;
  sourceBranch: string | null;
  model: 'sonnet' | 'opus' | 'auto';
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
};

export const CardDetail = observer(function CardDetail({ cardId, onClose, slotIndex }: Props) {
  const cardStore = useCardStore();
  const projectStore = useProjectStore();
  const sessionStore = useSessionStore();

  const card = cardStore.getCard(cardId);

  // Auto-close if the card is deleted (was loaded, then disappeared from store)
  const wasLoaded = useRef(false);
  if (card) wasLoaded.current = true;
  useEffect(() => {
    if (wasLoaded.current && !card) onClose();
  }, [card]); // eslint-disable-line react-hooks/exhaustive-deps

  const [draft, setDraft] = useState<Draft>({
    title: '',
    description: '',
    projectId: null,
    useWorktree: false,
    sourceBranch: null,
    model: 'sonnet',
    thinkingLevel: 'high',
  });

  const [formOpen, setFormOpen] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [archivePending, setArchivePending] = useState(false);
  const archiveRef = useRef<HTMLButtonElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // Sync draft from card data — keyed on card.id only to initialize form + collapse state once per card
  useEffect(() => {
    if (!card) return;
    setDraft({
      title: card.title,
      description: card.description ?? '',
      projectId: card.projectId,
      useWorktree: card.useWorktree,
      sourceBranch: card.sourceBranch,
      model: card.model,
      thinkingLevel: card.thinkingLevel,
    });
    // Auto-collapse when session exists
    setFormOpen(!card.sessionId && card.column !== 'running');
  }, [card?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-sync fields on update (but don't reset formOpen) — keyed on updatedAt to avoid resetting collapse state
  // Skip description sync if the textarea is focused to prevent cursor jumps during autosave
  useEffect(() => {
    if (!card) return;
    const titleFocused = document.activeElement === titleRef.current;
    const descFocused = document.activeElement === descRef.current;
    setDraft((d) => ({
      title: titleFocused ? d.title : card.title,
      description: descFocused ? d.description : (card.description ?? ''),
      projectId: card.projectId,
      useWorktree: card.useWorktree,
      sourceBranch: card.sourceBranch,
      model: card.model,
      thinkingLevel: card.thinkingLevel,
    }));
  }, [card?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save: 250ms debounce for text fields only
  useEffect(() => {
    if (!card) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveAll();
    }, 250);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [draft.title, draft.description]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = card
    ? draft.title !== card.title ||
      draft.description !== (card.description ?? '') ||
      draft.projectId !== card.projectId ||
      draft.useWorktree !== card.useWorktree ||
      draft.sourceBranch !== card.sourceBranch ||
      draft.model !== card.model ||
      draft.thinkingLevel !== card.thinkingLevel
    : false;

  async function saveAll(overrides?: Partial<Draft>) {
    if (!card) return;
    const merged = { ...draft, ...overrides };
    const dirty = overrides != null || isDirty;
    if (!dirty) return;
    await cardStore.updateCard({
      id: card.id,
      title: merged.title,
      description: merged.description,
      projectId: merged.projectId,
      useWorktree: merged.useWorktree,
      sourceBranch: merged.sourceBranch as 'main' | 'dev' | null | undefined,
      model: merged.model,
      thinkingLevel: merged.thinkingLevel,
    });
  }

  async function handleStatusChange(newColumn: string) {
    if (!card) return;
    if (newColumn === '__delete__') {
      setDeleteOpen(true);
      return;
    }
    if (newColumn === card.column) return;
    await cardStore.updateCard({ id: card.id, column: newColumn as Column });
    if (newColumn === 'done' || newColumn === 'archive') {
      onClose();
    }
  }

  if (!card) {
    // Store hydrated but card never found → invalid ID in URL
    if (cardStore.hydrated && !wasLoaded.current) {
      return (
        <div className="flex flex-col h-full items-center justify-center gap-2 text-muted-foreground px-6 text-center">
          <span className="text-2xl font-semibold text-foreground/30">404</span>
          <p className="text-sm">Card not found</p>
          <button
            className="mt-2 text-xs underline underline-offset-2 hover:text-foreground transition-colors"
            onClick={onClose}
          >
            Dismiss
          </button>
        </div>
      );
    }
    // Still loading or transitioning away after delete
    return null;
  }

  const selectedProject = draft.projectId != null ? projectStore.getProject(draft.projectId) : undefined;
  const cardProject = card.projectId != null ? projectStore.getProject(card.projectId) : undefined;
  const col = card.column;
  const sessionActive = sessionStore.getSession(cardId)?.active ?? false;
  const hasSession = !!card.sessionId || col === 'running';
  const showSession = hasSession;
  const projectLocked = !!card.projectId;

  async function saveField(field: 'title' | 'description', val: string) {
    await cardStore.updateCard({ id: card!.id, [field]: val });
  }

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Header bar — draggable for column-to-column reorder */}
        <div
          className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0 cursor-grab active:cursor-grabbing"
          draggable={slotIndex != null}
          onDragStart={(e) => {
            if (slotIndex == null) return;
            e.dataTransfer.setData('application/x-card-slot', JSON.stringify({ cardId, slotIndex }));
            e.dataTransfer.effectAllowed = 'move';
          }}
          <Select value={col} onValueChange={handleStatusChange}>
            <SelectTrigger className="w-auto border-none shadow-none px-0 h-auto gap-1.5 shrink-0">
              <Badge variant="outline" className="uppercase text-xs tracking-wide">
                <SelectValue />
              </Badge>
            </SelectTrigger>
            <SelectContent>
              {STATUSES.filter((s) => !sessionActive || s === col || s === 'done' || s === 'archive').map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabels[s]}
                </SelectItem>
              ))}
              {!sessionActive && (
                <>
                  <SelectSeparator />
                  <SelectItem value="__delete__" className="text-destructive focus:text-destructive">
                    Delete
                  </SelectItem>
                </>
              )}
            </SelectContent>
          </Select>
          {hasSession ? (
            <InlineEdit
              value={card.title}
              onSave={(v) => saveField('title', v)}
              className="text-sm font-medium flex-1 min-w-0"
              placeholder="Untitled"
              minLength={1}
            />
          ) : (
            <span className="text-sm font-medium truncate flex-1">{card.title}</span>
          )}
          {card.sessionId && <CopyResumeButton sessionId={card.sessionId} cardId={card.id} />}
          <span
            title={
              card.useWorktree
                ? `Worktree from: ${card.sourceBranch ?? cardProject?.defaultBranch ?? 'default branch'}`
                : 'No worktree'
            }
            className="flex items-center shrink-0"
            style={
              card.useWorktree && cardProject?.color
                ? {
                    color: `var(--${cardProject.color})`,
                    filter: `drop-shadow(0 0 4px var(--${cardProject.color}))`,
                  }
                : undefined
            }
          >
            <GitBranch className={cn('size-3.5', !card.useWorktree && 'text-dim')} />
          </span>
          {cardProject && (
            <Badge
              variant="secondary"
              className="text-xs shrink-0"
              style={cardProject.color ? { borderLeft: `3px solid var(--${cardProject.color})` } : undefined}
            >
              {cardProject.name}
            </Badge>
          )}
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {/* Collapsible form fields */}
        <Collapsible open={formOpen} onOpenChange={setFormOpen} className="shrink-0 border-b border-border">
          <CollapsibleTrigger className="flex items-center gap-1 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground w-full cursor-pointer">
            {formOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Details
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-4 pb-4 space-y-4">
              {/* Title */}
              {!hasSession && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Title</label>
                  <Input
                    ref={titleRef}
                    value={draft.title}
                    onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                    onBlur={() => saveAll()}
                  />
                </div>
              )}

              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
                {hasSession ? (
                  <InlineEdit
                    value={card.description ?? ''}
                    onSave={(v) => saveField('description', v)}
                    multiline
                    placeholder="Add a description..."
                  />
                ) : (
                  <Textarea
                    ref={descRef}
                    value={draft.description}
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                    onBlur={() => saveAll()}
                    rows={4}
                    placeholder="Add a description..."
                    className="resize-y max-h-40 overflow-y-auto"
                  />
                )}
              </div>

              {/* Project — only editable if not yet saved */}
              {!projectLocked && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Project</label>
                  <Select
                    value={draft.projectId != null ? String(draft.projectId) : '__none__'}
                    onValueChange={(val) => {
                      const pid = val === '__none__' ? null : Number(val);
                      const proj = pid != null ? projectStore.getProject(pid) : undefined;
                      const updates = {
                        projectId: pid,
                        useWorktree: proj?.isGitRepo ? (proj.defaultWorktree ?? false) : false,
                        sourceBranch: null as string | null,
                        model: proj?.defaultModel ?? draft.model,
                        thinkingLevel: proj?.defaultThinkingLevel ?? draft.thinkingLevel,
                      };
                      setDraft((d) => ({ ...d, ...updates }));
                      void saveAll(updates);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {projectStore.all.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          <span className="flex items-center gap-2">
                            {p.color && (
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: `var(--${p.color})` }}
                              />
                            )}
                            {p.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Use Worktree */}
              {!!selectedProject?.isGitRepo && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="useWorktree"
                    checked={draft.useWorktree}
                    disabled={!!card.worktreePath}
                    onCheckedChange={(checked) => {
                      const v = checked === true;
                      setDraft((d) => ({ ...d, useWorktree: v }));
                      saveAll({ useWorktree: v });
                    }}
                  />
                  <label htmlFor="useWorktree" className="text-sm font-medium text-muted-foreground">
                    Use worktree
                  </label>
                </div>
              )}

              {/* Source Branch */}
              {!!selectedProject?.isGitRepo && draft.useWorktree && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Source Branch</label>
                  <Select
                    value={draft.sourceBranch ?? selectedProject.defaultBranch ?? ''}
                    onValueChange={(val) => {
                      setDraft((d) => ({ ...d, sourceBranch: val }));
                      void saveAll({ sourceBranch: val });
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="main">main</SelectItem>
                      <SelectItem value="dev">dev</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Model & Thinking */}
              {!hasSession && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">Model</label>
                    <Select
                      value={draft.model}
                      onValueChange={(val) => {
                        setDraft((d) => ({ ...d, model: val as 'sonnet' | 'opus' | 'auto' }));
                        void saveAll({ model: val as 'sonnet' | 'opus' | 'auto' });
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        <SelectItem value="sonnet">Sonnet</SelectItem>
                        <SelectItem value="opus">Opus</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">Thinking</label>
                    <Select
                      value={draft.thinkingLevel}
                      onValueChange={(val) => {
                        setDraft((d) => ({ ...d, thinkingLevel: val as 'off' | 'low' | 'medium' | 'high' }));
                        void saveAll({ thinkingLevel: val as 'off' | 'low' | 'medium' | 'high' });
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Session view */}
        {showSession && (
          <SessionView
            cardId={card.id}
            sessionId={card.sessionId}
            accentColor={cardProject?.color}
            model={card.model ?? 'sonnet'}
            thinkingLevel={card.thinkingLevel ?? 'high'}
          />
        )}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            requestAnimationFrame(() => archiveRef.current?.focus());
          }}
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Remove card?</AlertDialogTitle>
            <AlertDialogDescription>What would you like to do with "{card.title}"?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="ghost"
              className="border border-neon-magenta/40 bg-neon-magenta/10 text-neon-magenta hover:bg-neon-magenta/20 hover:text-neon-magenta"
              disabled={deletePending}
              onClick={async () => {
                setDeletePending(true);
                try {
                  await cardStore.deleteCard(card.id);
                } finally {
                  setDeletePending(false);
                  setDeleteOpen(false);
                }
              }}
            >
              Delete
            </Button>
            <Button
              ref={archiveRef}
              variant="ghost"
              className="border border-neon-lime/40 bg-neon-lime/10 text-neon-lime hover:bg-neon-lime/20 hover:text-neon-lime"
              disabled={archivePending}
              onClick={async () => {
                setArchivePending(true);
                try {
                  await cardStore.updateCard({ id: card.id, column: 'archive', position: 0 });
                } finally {
                  setArchivePending(false);
                  setDeleteOpen(false);
                }
              }}
            >
              Archive
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});

type NewCardProps = {
  column: string;
  onCreated: (id: number) => void;
  onClose: () => void;
};

export const NewCardDetail = observer(function NewCardDetail({ column, onCreated, onClose }: NewCardProps) {
  const cardStore = useCardStore();
  const projectStore = useProjectStore();
  const descRef = useRef<HTMLTextAreaElement>(null);

  const [selectedColumn, setSelectedColumn] = useState(column);
  const [draft, setDraft] = useState<Draft>({
    title: '',
    description: '',
    projectId: null,
    useWorktree: false,
    sourceBranch: null,
    model: 'sonnet',
    thinkingLevel: 'high',
  });
  const [creating, setCreating] = useState(false);
  const [suggestingTitle, setSuggestingTitle] = useState(false);

  useEffect(() => {
    descRef.current?.focus();
  }, []);

  async function handleSave() {
    if (!draft.title.trim()) return;
    setCreating(true);
    try {
      const card = await cardStore.createCard({
        title: draft.title,
        description: draft.description || undefined,
        column: selectedColumn as Column,
        projectId: draft.projectId,
        useWorktree: draft.useWorktree,
        sourceBranch: draft.sourceBranch as 'main' | 'dev' | null | undefined,
        model: draft.model,
        thinkingLevel: draft.thinkingLevel,
      });
      if (selectedColumn === 'running' && draft.projectId && draft.description.trim()) {
        onCreated(card.id);
      } else {
        onClose();
      }
    } finally {
      setCreating(false);
    }
  }

  const selectedProject = draft.projectId != null ? projectStore.getProject(draft.projectId) : undefined;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <Select value={selectedColumn} onValueChange={setSelectedColumn}>
          <SelectTrigger size="sm" className="w-auto gap-1.5 border-border text-xs font-medium uppercase tracking-wide">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(statusLabels)
              .filter(([k]) => k !== 'archive')
              .map(([k, label]) => (
                <SelectItem key={k} value={k} className="text-xs uppercase tracking-wide">
                  {label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Title</label>
          <Input
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSave();
              }
            }}
            placeholder={suggestingTitle ? 'Generating title...' : 'Card title'}
            disabled={suggestingTitle}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
          <Textarea
            ref={descRef}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.shiftKey)) {
                e.preventDefault();
                handleSave();
              }
            }}
            onBlur={async () => {
              if (!draft.description.trim() || draft.title.trim()) return;
              setSuggestingTitle(true);
              try {
                const title = await cardStore.suggestTitle(draft.description);
                if (title) setDraft((d) => ({ ...d, title }));
              } finally {
                setSuggestingTitle(false);
              }
            }}
            rows={4}
            placeholder="Add a description..."
            className="resize-y max-h-40 overflow-y-auto"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Project</label>
          <Select
            value={draft.projectId != null ? String(draft.projectId) : '__none__'}
            onValueChange={(val) => {
              const pid = val === '__none__' ? null : Number(val);
              const proj = pid != null ? projectStore.getProject(pid) : undefined;
              setDraft((d) => ({
                ...d,
                projectId: pid,
                useWorktree: proj?.isGitRepo ? (proj.defaultWorktree ?? false) : false,
                sourceBranch: null,
                model: proj?.defaultModel ?? d.model,
                thinkingLevel: proj?.defaultThinkingLevel ?? d.thinkingLevel,
              }));
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {projectStore.all.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  <span className="flex items-center gap-2">
                    {p.color && (
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: `var(--${p.color})` }}
                      />
                    )}
                    {p.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!!selectedProject?.isGitRepo && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="newUseWorktree"
              checked={draft.useWorktree}
              onCheckedChange={(checked) => setDraft((d) => ({ ...d, useWorktree: checked === true }))}
            />
            <label htmlFor="newUseWorktree" className="text-sm font-medium text-muted-foreground">
              Use worktree
            </label>
          </div>
        )}

        {!!selectedProject?.isGitRepo && draft.useWorktree && (
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Source Branch</label>
            <Select
              value={draft.sourceBranch ?? selectedProject.defaultBranch ?? ''}
              onValueChange={(val) => setDraft((d) => ({ ...d, sourceBranch: val }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="main">main</SelectItem>
                <SelectItem value="dev">dev</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Model</label>
            <Select
              value={draft.model}
              onValueChange={(val) => setDraft((d) => ({ ...d, model: val as 'sonnet' | 'opus' | 'auto' }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="sonnet">Sonnet</SelectItem>
                <SelectItem value="opus">Opus</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Thinking</label>
            <Select
              value={draft.thinkingLevel}
              onValueChange={(val) =>
                setDraft((d) => ({ ...d, thinkingLevel: val as 'off' | 'low' | 'medium' | 'high' }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button className="w-full" disabled={!draft.title.trim() || creating} onClick={handleSave}>
          {creating ? 'Creating...' : 'Save'}
        </Button>
      </div>
    </div>
  );
});

function CopyResumeButton({ sessionId, cardId }: { sessionId: string; cardId: number }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(`${sessionId} # card ${cardId}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={handleCopy} title="Copy session ID">
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
