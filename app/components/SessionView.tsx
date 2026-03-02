import { useState, useRef, useEffect, useCallback } from 'react';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { MessageBlock } from './MessageBlock';

type Props = {
  cardId: number;
};

type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: Array<{ type: string; text: string }>;
};

export function SessionView({ cardId }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: statusData, isLoading } = useQuery(
    trpc.claude.status.queryOptions({ cardId })
  );

  const [messages, setMessages] = useState<Record<string, unknown>[]>([]);
  const [toolOutputs, setToolOutputs] = useState<Map<string, string>>(new Map());
  const bottomRef = useRef<HTMLDivElement>(null);

  const sessionActive = statusData?.active ?? false;
  const sessionStatus = statusData?.status ?? 'completed';

  // Extract tool outputs from user messages containing tool_result blocks
  const extractToolOutputs = useCallback((msg: Record<string, unknown>) => {
    if (msg.type !== 'user') return;
    const inner = msg.message as { content?: unknown } | undefined;
    if (!inner?.content || !Array.isArray(inner.content)) return;

    const results = inner.content as ToolResultBlock[];
    setToolOutputs((prev) => {
      const next = new Map(prev);
      for (const block of results) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const text = block.content
            ?.map((c) => c.text)
            .filter(Boolean)
            .join('\n');
          if (text) next.set(block.tool_use_id, text);
        }
      }
      return next;
    });
  }, []);

  // Subscribe to messages when session is active
  useSubscription(
    trpc.claude.onMessage.subscriptionOptions(
      { cardId },
      {
        enabled: sessionActive,
        onData: (msg) => {
          const data = msg as Record<string, unknown>;
          extractToolOutputs(data);
          setMessages((prev) => [...prev, data]);
        },
        onError: (err) => {
          console.error('Subscription error:', err);
        },
      }
    )
  );

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Refresh status when session completes (result message received)
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.type === 'result') {
      queryClient.invalidateQueries({ queryKey: trpc.claude.status.queryKey({ cardId }) });
    }
  }, [messages, queryClient, trpc, cardId]);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 text-center text-sm text-gray-500 dark:text-gray-400">
        Loading session...
      </div>
    );
  }

  // No active session -- show start form
  if (!sessionActive && messages.length === 0) {
    return <StartSessionForm cardId={cardId} />;
  }

  // Active or completed session with messages
  return (
    <div className="flex flex-col rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden" style={{ maxHeight: '60vh' }}>
      {/* Status bar */}
      <StatusBar status={sessionStatus} />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 min-h-0">
        {messages.map((msg, i) => (
          <MessageBlock key={i} message={msg} toolOutputs={toolOutputs} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {sessionActive && <MessageInput cardId={cardId} />}
    </div>
  );
}

// --- Status bar ---

function StatusBar({ status }: { status: string }) {
  let dot: string;
  let label: string;

  switch (status) {
    case 'running':
    case 'starting':
      dot = 'bg-green-500 animate-pulse';
      label = status === 'starting' ? 'Starting...' : 'Running';
      break;
    case 'completed':
      dot = 'bg-gray-400';
      label = 'Completed';
      break;
    default:
      dot = 'bg-red-500';
      label = 'Errored';
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
      <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
      <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{label}</span>
    </div>
  );
}

// --- Start session form ---

function StartSessionForm({ cardId }: { cardId: number }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');

  const startMutation = useMutation(
    trpc.claude.start.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.claude.status.queryKey({ cardId }) });
      },
    })
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) return;
    startMutation.mutate({ cardId, prompt: trimmed });
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
          Start a Claude session
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the task for Claude..."
          rows={3}
          className="w-full text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
        />
        <button
          type="submit"
          disabled={startMutation.isPending || !prompt.trim()}
          className="w-full px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
        >
          {startMutation.isPending ? 'Starting...' : 'Start Session'}
        </button>
        {startMutation.isError && (
          <p className="text-xs text-red-600 dark:text-red-400">
            {startMutation.error.message}
          </p>
        )}
      </form>
    </div>
  );
}

// --- Message input ---

function MessageInput({ cardId }: { cardId: number }) {
  const trpc = useTRPC();
  const [text, setText] = useState('');

  const sendMutation = useMutation(trpc.claude.sendMessage.mutationOptions());

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMutation.mutate({ cardId, message: trimmed });
    setText('');
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex gap-2 px-3 py-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex-shrink-0"
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Send a follow-up message..."
        className="flex-1 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md px-3 py-1.5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <button
        type="submit"
        disabled={sendMutation.isPending || !text.trim()}
        className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
      >
        Send
      </button>
    </form>
  );
}
