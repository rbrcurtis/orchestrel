import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SessionView } from './SessionView';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '~/components/ui/select';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';

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

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const priorityLabels: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

type Draft = {
  title: string;
  description: string;
  priority: string;
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
    priority: 'medium',
    repoId: null,
    useWorktree: false,
    sourceBranch: null,
  });

  // Sync draft from card data
  useEffect(() => {
    if (!card) return;
    setDraft({
      title: card.title,
      description: card.description ?? '',
      priority: card.priority,
      repoId: card.repoId,
      useWorktree: card.useWorktree,
      sourceBranch: card.sourceBranch,
    });
  }, [card?.id, card?.updatedAt]);

  const isDirty = card
    ? draft.title !== card.title ||
      draft.description !== (card.description ?? '') ||
      draft.priority !== card.priority ||
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

  const moveMutation = useMutation(
    trpc.cards.move.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
      },
    })
  );

  function handleSave() {
    if (!card || !isDirty) return;
    updateMutation.mutate({
      id: card.id,
      title: draft.title,
      description: draft.description,
      priority: draft.priority,
      repoId: draft.repoId,
      useWorktree: draft.useWorktree,
      sourceBranch: draft.sourceBranch,
    });
  }

  function handleStatusChange(newColumn: string) {
    if (!card || newColumn === card.column) return;
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
  const col = card.column;
  const showSession =
    (col === 'in_progress' || col === 'review') &&
    (card.repoId || card.worktreePath);

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <Badge variant="outline" className="uppercase text-xs tracking-wide">
          {statusLabels[col] ?? col}
        </Badge>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Status dropdown */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Status
          </label>
          <Select value={col} onValueChange={handleStatusChange}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Title */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Title
          </label>
          <Input
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Description
          </label>
          <Textarea
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            rows={4}
            placeholder="Add a description..."
            className="resize-y"
          />
        </div>

        {/* Priority */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Priority
          </label>
          <Select
            value={draft.priority}
            onValueChange={(val) => setDraft((d) => ({ ...d, priority: val }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {priorityLabels[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Repository */}
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Repository
          </label>
          <Select
            value={draft.repoId != null ? String(draft.repoId) : '__none__'}
            onValueChange={(val) =>
              setDraft((d) => ({
                ...d,
                repoId: val === '__none__' ? null : Number(val),
                // Reset worktree settings when repo changes
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

        {/* Non-git repo indicator */}
        {draft.repoId && selectedRepo && !selectedRepo.isGitRepo && (
          <p className="text-xs text-muted-foreground">
            Working directory (not a git repo)
          </p>
        )}

        {/* Source Branch */}
        {selectedRepo?.isGitRepo && draft.useWorktree && (
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Source Branch
            </label>
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

        {/* Save button */}
        <Button
          className="w-full"
          disabled={!isDirty || updateMutation.isPending}
          onClick={handleSave}
        >
          {updateMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>

      {/* Session view */}
      {showSession && (
        <SessionView cardId={card.id} sessionId={card.sessionId} />
      )}
    </div>
  );
}
