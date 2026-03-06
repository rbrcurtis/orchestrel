import { useState, useEffect, useRef, useMemo } from 'react';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SessionView } from './SessionView';
import { MessageBlock } from './MessageBlock';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '~/components/ui/sheet';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '~/components/ui/select';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';
import { ScrollArea } from '~/components/ui/scroll-area';

type Props = {
  cardId: number;
  onClose: () => void;
};

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const priorityLabels: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export function CardDetailPanel({ cardId, onClose }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: allCards } = useQuery(trpc.cards.list.queryOptions());
  const card = allCards?.find((c) => c.id === cardId);

  const { data: repos } = useQuery(trpc.repos.list.queryOptions());

  const updateMutation = useMutation(
    trpc.cards.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
      },
    })
  );

  if (!card) {
    return (
      <Sheet open={true} onOpenChange={() => onClose()}>
        <SheetContent side="right" className="w-full sm:w-1/3 sm:max-w-none">
          <SheetHeader>
            <SheetTitle>Card</SheetTitle>
            <SheetDescription>Card not found</SheetDescription>
          </SheetHeader>
          <p className="p-6 text-center text-muted-foreground">Card not found</p>
        </SheetContent>
      </Sheet>
    );
  }

  const col = card.column as 'backlog' | 'ready' | 'in_progress' | 'review' | 'done';
  const isEditable = col === 'backlog' || col === 'ready';

  return (
    <Sheet open={true} onOpenChange={() => onClose()}>
      <SheetContent side="right" className="w-full sm:w-1/3 sm:max-w-none flex flex-col overflow-hidden">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="uppercase text-xs tracking-wide">
              {col.replace('_', ' ')}
            </Badge>
          </div>
          <SheetTitle className="sr-only">{card.title}</SheetTitle>
          <SheetDescription className="sr-only">Card detail panel</SheetDescription>
        </SheetHeader>

        {/* Top: card metadata (shrinks) */}
        <div className="px-4 pb-4 space-y-4 shrink-0">
          {/* Title */}
          {isEditable ? (
            <EditableTitle
              value={card.title}
              onSave={(title) => updateMutation.mutate({ id: card.id, title })}
            />
          ) : (
            <h2 className="text-lg font-semibold text-foreground">
              {card.title}
            </h2>
          )}

          {/* Description */}
          {isEditable ? (
            <EditableDescription
              value={card.description ?? ''}
              onSave={(description) =>
                updateMutation.mutate({ id: card.id, description })
              }
            />
          ) : card.description ? (
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">
              {card.description}
            </div>
          ) : null}

          {/* Card fields — editable for backlog/ready, read-only summary otherwise */}
          {isEditable ? (
            <EditableFields
              card={card}
              repos={repos ?? []}
              onUpdate={(data) => updateMutation.mutate({ id: card.id, ...data })}
            />
          ) : (
            <ReadOnlyFields card={card} repos={repos ?? []} />
          )}
        </div>

        {/* Middle + Bottom: session area (grows to fill) */}
        {(col === 'in_progress' || col === 'review') && (
          card.repoId || card.worktreePath ? (
            <SessionView cardId={card.id} sessionId={card.sessionId} />
          ) : (
            <div className="px-4 text-sm text-muted-foreground italic">
              No repo linked - assign a repo to enable Claude sessions
            </div>
          )
        )}

        {col === 'done' && (
          <div className="px-4 pb-6 overflow-y-auto flex-1 min-h-0">
            <DoneContent card={card} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// --- Editable fields for backlog/ready ---

function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    } else {
      setDraft(value);
    }
  }

  return (
    <Input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') ref.current?.blur();
      }}
      className="text-lg font-semibold border-transparent shadow-none hover:border-input focus-visible:border-ring"
    />
  );
}

function EditableDescription({
  value,
  onSave,
}: {
  value: string;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    if (draft !== value) {
      onSave(draft);
    }
  }

  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">
        Description
      </label>
      <Textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={4}
        placeholder="Add a description..."
        className="resize-y"
      />
    </div>
  );
}

type CardData = {
  id: number;
  title: string;
  description: string | null;
  column: string;
  priority: string;
  repoId: number | null;
  prUrl: string | null;
  sessionId: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  useWorktree: boolean;
  sourceBranch: string | null;
};

type RepoData = {
  id: number;
  name: string;
  isGitRepo: boolean;
  defaultBranch: string | null;
};

function EditableFields({
  card,
  repos,
  onUpdate,
}: {
  card: CardData;
  repos: RepoData[];
  onUpdate: (data: { priority?: string; repoId?: number | null; useWorktree?: boolean; sourceBranch?: string | null }) => void;
}) {
  const selectedRepo = repos.find(r => r.id === card.repoId);

  return (
    <div className="space-y-4">
      {/* Priority */}
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">
          Priority
        </label>
        <Select
          value={card.priority}
          onValueChange={(val) => onUpdate({ priority: val })}
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

      {/* Repo */}
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">
          Repository
        </label>
        <Select
          value={card.repoId != null ? String(card.repoId) : '__none__'}
          onValueChange={(val) => {
            onUpdate({ repoId: val === '__none__' ? null : Number(val) });
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {repos.map((r) => (
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
            checked={card.useWorktree}
            disabled={!!card.worktreePath}
            onCheckedChange={(checked) => onUpdate({ useWorktree: checked === true })}
          />
          <label htmlFor="useWorktree" className="text-sm font-medium text-muted-foreground">
            Use worktree
          </label>
        </div>
      )}

      {/* Non-git repo indicator */}
      {card.repoId && selectedRepo && !selectedRepo.isGitRepo && (
        <p className="text-xs text-muted-foreground">
          Working directory (not a git repo)
        </p>
      )}

      {/* Source Branch */}
      {selectedRepo?.isGitRepo && card.useWorktree && (
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Source Branch
          </label>
          <Select
            value={card.sourceBranch ?? selectedRepo.defaultBranch ?? ''}
            onValueChange={(val) => onUpdate({ sourceBranch: val })}
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
  );
}

function ReadOnlyFields({ card, repos }: { card: CardData; repos: RepoData[] }) {
  const repo = repos.find(r => r.id === card.repoId);

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span><span className="font-medium">Priority:</span> {priorityLabels[card.priority] ?? card.priority}</span>
      {repo && <span><span className="font-medium">Repo:</span> {repo.name}</span>}
      {card.useWorktree && card.worktreeBranch && (
        <span><span className="font-medium">Worktree:</span> {card.worktreeBranch}</span>
      )}
      {card.sourceBranch && (
        <span><span className="font-medium">Source:</span> {card.sourceBranch}</span>
      )}
    </div>
  );
}

// --- Done content ---

function DoneContent({ card }: { card: CardData }) {
  return (
    <div className="space-y-4">
      <SessionLog sessionId={card.sessionId} />
    </div>
  );
}

// --- Session log (read-only historical messages) ---

type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: Array<{ type: string; text: string }>;
};

function SessionLog({ sessionId }: { sessionId: string | null }) {
  const trpc = useTRPC();

  const { data, isLoading, isError } = useQuery(
    trpc.sessions.loadSession.queryOptions(
      { sessionId: sessionId! },
      { enabled: !!sessionId }
    )
  );

  // Extract tool outputs from user messages
  const toolOutputs = useMemo(() => {
    const map = new Map<string, string>();
    if (!data) return map;

    for (const msg of data) {
      if (msg.type !== 'user') continue;
      const inner = msg.message as { content?: unknown } | undefined;
      if (!inner?.content || !Array.isArray(inner.content)) continue;

      for (const block of inner.content as ToolResultBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const text = block.content
            ?.map((c) => c.text)
            .filter(Boolean)
            .join('\n');
          if (text) map.set(block.tool_use_id, text);
        }
      }
    }
    return map;
  }, [data]);

  if (!sessionId) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 text-center text-sm text-muted-foreground">
        No session log
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 text-center text-sm text-muted-foreground">
        Loading session log...
      </div>
    );
  }

  if (isError || !data || data.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 text-center text-sm text-muted-foreground">
        No session log available
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <span className="text-xs font-medium text-muted-foreground">
          Session Log
        </span>
      </div>
      <ScrollArea className="px-3 py-2" style={{ maxHeight: '50vh' }}>
        <div className="space-y-1">
          {data.map((msg, i) => (
            <MessageBlock
              key={i}
              message={msg as Record<string, unknown>}
              toolOutputs={toolOutputs}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
