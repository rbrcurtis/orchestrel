import { useState, useEffect, useRef } from 'react';
import { X, ChevronDown, ChevronRight } from 'lucide-react';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SessionView } from './SessionView';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '~/components/ui/select';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '~/components/ui/collapsible';

type Props = {
  cardId: number;
  onClose: () => void;
};

const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done'] as const;
const statusLabels: Record<string, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

type Draft = {
  title: string;
  description: string;
  repoId: number | null;
  useWorktree: boolean;
  sourceBranch: string | null;
};

export function CardDetail({ cardId, onClose }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: allCards } = useQuery(trpc.cards.list.queryOptions());
  const card = allCards?.find((c) => c.id === cardId);

  const { data: repos } = useQuery(trpc.repos.list.queryOptions());

  const [draft, setDraft] = useState<Draft>({
    title: '',
    description: '',
    repoId: null,
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
      repoId: card.repoId,
      useWorktree: card.useWorktree,
      sourceBranch: card.sourceBranch,
    });
    // Auto-collapse for in_progress/review
    setFormOpen(card.column !== 'in_progress' && card.column !== 'review');
  }, [card?.id]);

  // Re-sync fields on update (but don't reset formOpen)
  useEffect(() => {
    if (!card) return;
    setDraft({
      title: card.title,
      description: card.description ?? '',
      repoId: card.repoId,
      useWorktree: card.useWorktree,
      sourceBranch: card.sourceBranch,
    });
  }, [card?.updatedAt]);

  const isDirty = card
    ? draft.title !== card.title ||
      draft.description !== (card.description ?? '') ||
      draft.repoId !== card.repoId ||
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
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!card || !isDirty) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateMutation.mutate({
        id: card.id,
        title: draft.title,
        description: draft.description,
        repoId: draft.repoId,
        useWorktree: draft.useWorktree,
        sourceBranch: draft.sourceBranch,
      });
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [draft]);

  function handleStatusChange(newColumn: string) {
    if (!card || newColumn === card.column) return;
    if (newColumn === 'in_progress' && card.repoId && card.description?.trim() && !card.sessionId) {
      pendingClaudeStart.current = { cardId: card.id, prompt: card.description.trim() };
    }
    moveMutation.mutate({ id: card.id, column: newColumn, position: 0 });
  }

  if (!card) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-muted-foreground">
        Card not found
      </div>
    );
  }

  const selectedRepo = repos?.find((r) => r.id === draft.repoId);
  const cardRepo = repos?.find((r) => r.id === card.repoId);
  const col = card.column;
  const showSession =
    (col === 'in_progress' || col === 'review') &&
    (card.repoId || card.worktreePath);
  const repoLocked = !!card.repoId;

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <Select value={col} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-auto border-none shadow-none px-0 h-auto gap-1.5 shrink-0">
            <Badge variant="outline" className="uppercase text-xs tracking-wide">
              <SelectValue />
            </Badge>
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {statusLabels[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm font-medium truncate flex-1">{card.title}</span>
        {cardRepo && (
          <Badge variant="secondary" className="text-xs shrink-0">{cardRepo.name}</Badge>
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
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Title</label>
              <Input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
              <Textarea
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                rows={4}
                placeholder="Add a description..."
                className="resize-y"
                disabled={!!card.sessionId}
              />
            </div>

            {/* Repository — only editable if not yet saved */}
            {!repoLocked && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Repository</label>
                <Select
                  value={draft.repoId != null ? String(draft.repoId) : '__none__'}
                  onValueChange={(val) =>
                    setDraft((d) => ({
                      ...d,
                      repoId: val === '__none__' ? null : Number(val),
                      useWorktree: false,
                      sourceBranch: null,
                    }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {(repos ?? []).map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Use Worktree */}
            {selectedRepo?.isGitRepo && (
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
            {selectedRepo?.isGitRepo && draft.useWorktree && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Source Branch</label>
                <Select
                  value={draft.sourceBranch ?? selectedRepo.defaultBranch ?? ''}
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
        <SessionView cardId={card.id} sessionId={card.sessionId} />
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
  const titleRef = useRef<HTMLInputElement>(null);

  const { data: repos } = useQuery(trpc.repos.list.queryOptions());

  const [draft, setDraft] = useState<Draft>({
    title: '',
    description: '',
    repoId: null,
    useWorktree: false,
    sourceBranch: null,
  });

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const startClaudeMutation = useMutation(
    trpc.claude.start.mutationOptions({})
  );

  const createMutation = useMutation(
    trpc.cards.create.mutationOptions({
      onSuccess: (card) => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
        if (column === 'in_progress' && draft.repoId && draft.description.trim()) {
          startClaudeMutation.mutate({ cardId: card.id, prompt: draft.description.trim() });
        }
        onCreated(card.id);
      },
    })
  );

  function handleSave() {
    if (!draft.title.trim()) return;
    createMutation.mutate({
      title: draft.title,
      description: draft.description || undefined,
      column,
      repoId: draft.repoId,
      useWorktree: draft.useWorktree,
      sourceBranch: draft.sourceBranch,
    });
  }

  const selectedRepo = repos?.find((r) => r.id === draft.repoId);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <Badge variant="outline" className="uppercase text-xs tracking-wide">
          {statusLabels[column] ?? column}
        </Badge>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Title</label>
          <Input
            ref={titleRef}
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            placeholder="Card title"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
          <Textarea
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            rows={4}
            placeholder="Add a description..."
            className="resize-y"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Repository</label>
          <Select
            value={draft.repoId != null ? String(draft.repoId) : '__none__'}
            onValueChange={(val) =>
              setDraft((d) => ({
                ...d,
                repoId: val === '__none__' ? null : Number(val),
                useWorktree: false,
                sourceBranch: null,
              }))
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {(repos ?? []).map((r) => (
                <SelectItem key={r.id} value={String(r.id)}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedRepo?.isGitRepo && (
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

        {selectedRepo?.isGitRepo && draft.useWorktree && (
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Source Branch</label>
            <Select
              value={draft.sourceBranch ?? selectedRepo.defaultBranch ?? ''}
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
          disabled={!draft.title.trim() || createMutation.isPending}
          onClick={handleSave}
        >
          {createMutation.isPending ? 'Creating...' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
