import { useState, useEffect, useRef } from 'react';
import { X, ChevronDown, ChevronRight, Copy, Check, GitBranch } from 'lucide-react';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SessionView } from './SessionView';
import { InlineEdit } from './InlineEdit';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '~/components/ui/select';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '~/components/ui/collapsible';
import { cn } from '~/lib/utils';

type Props = {
  cardId: number;
  onClose: () => void;
};

const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done', 'archive'] as const;
const statusLabels: Record<string, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
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
};

export function CardDetail({ cardId, onClose }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: allCards, isPending } = useQuery(trpc.cards.list.queryOptions());
  const card = allCards?.find((c) => c.id === cardId);

  const { data: projectsList } = useQuery(trpc.projects.list.queryOptions());

  const [draft, setDraft] = useState<Draft>({
    title: '',
    description: '',
    projectId: null,
    useWorktree: false,
    sourceBranch: null,
  });

  const [formOpen, setFormOpen] = useState(true);

  // Sync draft from card data
  useEffect(() => {
    if (!card) return;
    setDraft({
      title: card.title,
      description: card.description ?? '',
      projectId: card.projectId,
      useWorktree: card.useWorktree,
      sourceBranch: card.sourceBranch,
    });
    // Auto-collapse for in_progress/review
    setFormOpen(card.column !== 'in_progress' && card.column !== 'review' && card.column !== 'done' && card.column !== 'archive');
  }, [card?.id]);

  // Re-sync fields on update (but don't reset formOpen)
  useEffect(() => {
    if (!card) return;
    setDraft({
      title: card.title,
      description: card.description ?? '',
      projectId: card.projectId,
      useWorktree: card.useWorktree,
      sourceBranch: card.sourceBranch,
    });
  }, [card?.updatedAt]);

  const isDirty = card
    ? draft.title !== card.title ||
      draft.description !== (card.description ?? '') ||
      draft.projectId !== card.projectId ||
      draft.useWorktree !== card.useWorktree ||
      draft.sourceBranch !== card.sourceBranch
    : false;

  const updateMutation = useMutation(
    trpc.cards.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
      },
    })
  );

  const startClaudeMutation = useMutation(
    trpc.claude.start.mutationOptions({})
  );

  const pendingClaudeStart = useRef<{ cardId: number; prompt: string } | null>(null);

  const moveMutation = useMutation(
    trpc.cards.move.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
        if (pendingClaudeStart.current) {
          startClaudeMutation.mutate(pendingClaudeStart.current);
          pendingClaudeStart.current = null;
        }
      },
    })
  );

  // Auto-save on change with debounce
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!card || !isDirty) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateMutation.mutate({
        id: card.id,
        title: draft.title,
        description: draft.description,
        projectId: draft.projectId,
        useWorktree: draft.useWorktree,
        sourceBranch: draft.sourceBranch as 'main' | 'dev' | null | undefined,
      });
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [draft]);

  function handleStatusChange(newColumn: string) {
    if (!card || newColumn === card.column) return;
    if (newColumn === 'in_progress' && card.projectId && card.description?.trim() && !card.sessionId) {
      pendingClaudeStart.current = { cardId: card.id, prompt: card.description.trim() };
    }
    moveMutation.mutate(
      { id: card.id, column: newColumn as 'backlog' | 'ready' | 'in_progress' | 'review' | 'done' | 'archive', position: 0 },
      {
        onSuccess: () => {
          if (newColumn === 'done' || newColumn === 'archive') {
            onClose();
          }
        },
      }
    );
  }

  if (!card) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-muted-foreground">
        {isPending ? (
          <svg className="size-6 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : 'Card not found'}
      </div>
    );
  }

  const selectedProject = projectsList?.find((p) => p.id === draft.projectId);
  const cardProject = projectsList?.find((p) => p.id === card.projectId);
  const col = card.column;
  const isActive = col === 'in_progress' || col === 'review' || col === 'done' || col === 'archive';
  const showSession = isActive && (card.projectId || card.worktreePath);
  const projectLocked = !!card.projectId;

  async function saveField(field: 'title' | 'description', val: string) {
    await updateMutation.mutateAsync({ id: card!.id, [field]: val });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <Select value={col} onValueChange={handleStatusChange}>
          <div className={col === 'in_progress' ? 'cursor-not-allowed' : ''}>
            <SelectTrigger className={cn('w-auto border-none shadow-none px-0 h-auto gap-1.5 shrink-0', col === 'in_progress' && 'pointer-events-none')}>
              <Badge variant="outline" className="uppercase text-xs tracking-wide">
                <SelectValue />
              </Badge>
            </SelectTrigger>
          </div>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {statusLabels[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isActive ? (
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
        {card.sessionId && <CopyResumeButton sessionId={card.sessionId} />}
        <span
          title={card.useWorktree ? 'Worktree enabled' : 'No worktree'}
          className="flex items-center shrink-0"
          style={card.useWorktree && cardProject?.color ? {
            color: `var(--${cardProject.color})`,
            filter: `drop-shadow(0 0 4px var(--${cardProject.color}))`,
          } : undefined}
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
            {!isActive && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Title</label>
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                />
              </div>
            )}

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
              {isActive ? (
                <InlineEdit
                  value={card.description ?? ''}
                  onSave={(v) => saveField('description', v)}
                  multiline
                  placeholder="Add a description..."
                />
              ) : (
                <Textarea
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  rows={4}
                  placeholder="Add a description..."
                  className="resize-y"
                  disabled={!!card.sessionId}
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
                    const proj = projectsList?.find(p => p.id === pid);
                    setDraft((d) => ({
                      ...d,
                      projectId: pid,
                      useWorktree: proj?.isGitRepo ? (proj.defaultWorktree ?? false) : false,
                      sourceBranch: null,
                    }));
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {(projectsList ?? []).map((p) => (
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
            {selectedProject?.isGitRepo && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="useWorktree"
                  checked={draft.useWorktree}
                  disabled={!!card.worktreePath}
                  onCheckedChange={(checked) =>
                    setDraft((d) => ({ ...d, useWorktree: checked === true }))
                  }
                />
                <label htmlFor="useWorktree" className="text-sm font-medium text-muted-foreground">
                  Use worktree
                </label>
              </div>
            )}

            {/* Source Branch */}
            {selectedProject?.isGitRepo && draft.useWorktree && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Source Branch</label>
                <Select
                  value={draft.sourceBranch ?? selectedProject.defaultBranch ?? ''}
                  onValueChange={(val) =>
                    setDraft((d) => ({ ...d, sourceBranch: val }))
                  }
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
  );
}

type NewCardProps = {
  column: string;
  onCreated: (id: number) => void;
  onClose: () => void;
};

export function NewCardDetail({ column, onCreated, onClose }: NewCardProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const descRef = useRef<HTMLTextAreaElement>(null);

  const { data: projectsList } = useQuery(trpc.projects.list.queryOptions());

  const [selectedColumn, setSelectedColumn] = useState(column);
  const [draft, setDraft] = useState<Draft>({
    title: '',
    description: '',
    projectId: null,
    useWorktree: false,
    sourceBranch: null,
  });

  useEffect(() => {
    descRef.current?.focus();
  }, []);

  const generateTitleMutation = useMutation(
    trpc.cards.generateTitle.mutationOptions({
      onSuccess: (result) => {
        setDraft((d) => ({ ...d, title: result.title }));
      },
    })
  );

  const startClaudeMutation = useMutation(
    trpc.claude.start.mutationOptions({})
  );

  const createMutation = useMutation(
    trpc.cards.create.mutationOptions({
      onSuccess: (card) => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
        if (selectedColumn === 'in_progress' && draft.projectId && draft.description.trim()) {
          startClaudeMutation.mutate({ cardId: card.id, prompt: draft.description.trim() });
          onCreated(card.id);
        } else {
          onClose();
        }
      },
    })
  );

  function handleSave() {
    if (!draft.title.trim()) return;
    createMutation.mutate({
      title: draft.title,
      description: draft.description || undefined,
      column: selectedColumn as 'backlog' | 'ready' | 'in_progress' | 'review' | 'done' | 'archive',
      projectId: draft.projectId,
      useWorktree: draft.useWorktree,
      sourceBranch: draft.sourceBranch as 'main' | 'dev' | null | undefined,
    });
  }

  const selectedProject = projectsList?.find((p) => p.id === draft.projectId);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <Select value={selectedColumn} onValueChange={setSelectedColumn}>
          <SelectTrigger size="sm" className="w-auto gap-1.5 border-border text-xs font-medium uppercase tracking-wide">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(statusLabels).filter(([k]) => k !== 'archive').map(([k, label]) => (
              <SelectItem key={k} value={k} className="text-xs uppercase tracking-wide">{label}</SelectItem>
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
            placeholder={generateTitleMutation.isPending ? 'Generating title...' : 'Card title'}
            disabled={generateTitleMutation.isPending}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
          <Textarea
            ref={descRef}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            onBlur={() => {
              if (!draft.title.trim() && draft.description.trim()) {
                generateTitleMutation.mutate({ description: draft.description.trim() });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                handleSave();
              }
            }}
            rows={4}
            placeholder="Add a description..."
            className="resize-y"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Project</label>
          <Select
            value={draft.projectId != null ? String(draft.projectId) : '__none__'}
            onValueChange={(val) => {
              const pid = val === '__none__' ? null : Number(val);
              const proj = projectsList?.find(p => p.id === pid);
              setDraft((d) => ({
                ...d,
                projectId: pid,
                useWorktree: proj?.isGitRepo ? (proj.defaultWorktree ?? false) : false,
                sourceBranch: null,
              }));
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {(projectsList ?? []).map((p) => (
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

        {selectedProject?.isGitRepo && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="newUseWorktree"
              checked={draft.useWorktree}
              onCheckedChange={(checked) =>
                setDraft((d) => ({ ...d, useWorktree: checked === true }))
              }
            />
            <label htmlFor="newUseWorktree" className="text-sm font-medium text-muted-foreground">
              Use worktree
            </label>
          </div>
        )}

        {selectedProject?.isGitRepo && draft.useWorktree && (
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

        <Button
          className="w-full"
          disabled={!draft.title.trim() || generateTitleMutation.isPending || createMutation.isPending}
          onClick={handleSave}
        >
          {createMutation.isPending ? 'Creating...' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function CopyResumeButton({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(`claude --resume ${sessionId}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0 shrink-0"
      onClick={handleCopy}
      title="Copy resume command"
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
