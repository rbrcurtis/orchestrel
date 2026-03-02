import { useState, useEffect, useRef } from 'react';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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

  // Escape key to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Slide-in animation
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  function handleClose() {
    setVisible(false);
    setTimeout(onClose, 200);
  }

  if (!card) {
    return (
      <>
        <div className="fixed inset-0 bg-black/20 z-40" onClick={handleClose} />
        <div className="fixed inset-y-0 right-0 w-full sm:w-[420px] bg-white dark:bg-gray-900 shadow-xl z-50 flex items-center justify-center">
          <p className="text-gray-500 dark:text-gray-400">Card not found</p>
        </div>
      </>
    );
  }

  const col = card.column as 'backlog' | 'ready' | 'in_progress' | 'review' | 'done';
  const isEditable = col === 'backlog' || col === 'ready';

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/20 z-40 transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={handleClose}
      />
      {/* Panel */}
      <div
        className={`fixed inset-y-0 right-0 w-full sm:w-[420px] bg-white dark:bg-gray-900 shadow-xl z-50 overflow-y-auto transition-transform duration-200 ${visible ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {col.replace('_', ' ')}
            </span>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <span className="text-lg leading-none">&times;</span>
            </button>
          </div>

          {/* Title */}
          {isEditable ? (
            <EditableTitle
              value={card.title}
              onSave={(title) => updateMutation.mutate({ id: card.id, title })}
            />
          ) : (
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
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
          ) : (
            <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
              {card.description || 'No description'}
            </div>
          )}

          {/* Column-specific content */}
          {isEditable && (
            <EditableFields
              card={card}
              repos={repos ?? []}
              onUpdate={(data) => updateMutation.mutate({ id: card.id, ...data })}
            />
          )}

          {col === 'in_progress' && (
            <InProgressContent card={card} />
          )}

          {col === 'review' && (
            <ReviewContent
              card={card}
              onUpdate={(data) => updateMutation.mutate({ id: card.id, ...data })}
            />
          )}

          {col === 'done' && (
            <DoneContent card={card} />
          )}
        </div>
      </div>
    </>
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
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') ref.current?.blur();
      }}
      className="w-full text-lg font-semibold text-gray-900 dark:text-gray-100 bg-transparent border-b border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none pb-1 transition-colors"
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
      <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
        Description
      </label>
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={4}
        placeholder="Add a description..."
        className="w-full text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 resize-y"
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
};

type RepoData = {
  id: number;
  displayName: string;
  name: string;
};

function EditableFields({
  card,
  repos,
  onUpdate,
}: {
  card: CardData;
  repos: RepoData[];
  onUpdate: (data: { priority?: string; repoId?: number | null }) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Priority */}
      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Priority
        </label>
        <select
          value={card.priority}
          onChange={(e) => onUpdate({ priority: e.target.value })}
          className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {priorityLabels[p]}
            </option>
          ))}
        </select>
      </div>

      {/* Repo */}
      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Repository
        </label>
        <select
          value={card.repoId ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            onUpdate({ repoId: v ? Number(v) : null });
          }}
          className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">None</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.displayName}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// --- In Progress content ---

function InProgressContent({ card }: { card: CardData }) {
  return (
    <div>
      {card.repoId ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 text-center text-sm text-gray-500 dark:text-gray-400">
          Claude session area
        </div>
      ) : (
        <div className="text-sm text-gray-500 dark:text-gray-400 italic">
          No repo linked - assign a repo to enable Claude sessions
        </div>
      )}
    </div>
  );
}

// --- Review content ---

function ReviewContent({
  card,
  onUpdate,
}: {
  card: CardData;
  onUpdate: (data: { prUrl?: string | null }) => void;
}) {
  const [draft, setDraft] = useState(card.prUrl ?? '');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(card.prUrl ?? '');
  }, [card.prUrl]);

  function commit() {
    const trimmed = draft.trim();
    const newVal = trimmed || null;
    if (newVal !== card.prUrl) {
      onUpdate({ prUrl: newVal });
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          PR URL
        </label>
        <input
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ref.current?.blur();
          }}
          placeholder="https://github.com/..."
          className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      {card.prUrl && (
        <a
          href={card.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          Open PR &rarr;
        </a>
      )}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 text-center text-sm text-gray-500 dark:text-gray-400">
        Session output placeholder
      </div>
    </div>
  );
}

// --- Done content ---

function DoneContent({ card }: { card: CardData }) {
  return (
    <div className="space-y-4">
      {card.prUrl && (
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            PR URL
          </label>
          <a
            href={card.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            {card.prUrl} &rarr;
          </a>
        </div>
      )}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 text-center text-sm text-gray-500 dark:text-gray-400">
        Session log placeholder
      </div>
    </div>
  );
}
