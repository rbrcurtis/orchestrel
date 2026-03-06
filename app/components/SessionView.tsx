import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Send, Square, AlertCircle } from 'lucide-react';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { MessageBlock } from './MessageBlock';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import { Badge } from '~/components/ui/badge';
import { Alert, AlertDescription } from '~/components/ui/alert';

type Props = {
  cardId: number;
  sessionId?: string | null;
};

type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: Array<{ type: string; text: string }>;
};

export function SessionView({ cardId, sessionId }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: statusData } = useQuery({
    ...trpc.claude.status.queryOptions({ cardId }),
    refetchInterval: 3000,
  });

  // Load historical session messages when not actively streaming
  const { data: historyData } = useQuery(
    trpc.sessions.loadSession.queryOptions(
      { sessionId: sessionId! },
      { enabled: !!sessionId },
    )
  );

  const [liveMessages, setLiveMessages] = useState<Record<string, unknown>[]>([]);
  const [subscribing, setSubscribing] = useState(false);
  const seenIds = useRef(new Set<number>());
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset live state when switching cards
  useEffect(() => {
    setLiveMessages([]);
    setSubscribing(false);
    seenIds.current.clear();
  }, [cardId]);

  const sessionActive = statusData?.active ?? false;
  const sessionStatus = statusData?.status ?? 'completed';
  const promptsSent = statusData?.promptsSent ?? 0;
  const turnsCompleted = statusData?.turnsCompleted ?? 0;

  // Merge history + live messages (live may replay history, so deduplicate)
  const isStreaming = sessionActive || subscribing;
  const history = (historyData as Record<string, unknown>[] | undefined) ?? [];
  const messages = useMemo(() => {
    if (liveMessages.length === 0) return history;
    // Live subscription replays buffered messages then streams new ones.
    // History covers everything before this process lifecycle.
    // Use history as base, then append any live messages beyond history length.
    if (liveMessages.length > history.length) {
      return [...history, ...liveMessages.slice(history.length)];
    }
    // Live is still catching up or equal — just show whichever is longer
    return liveMessages.length >= history.length ? liveMessages : history;
  }, [history, liveMessages]);

  // Extract tool outputs from all messages
  const toolOutputs = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
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
  }, [messages]);

  // Move card to in_progress when starting a session
  const moveMutation = useMutation(
    trpc.cards.move.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
      },
    })
  );

  // Start mutation
  const startMutation = useMutation(
    trpc.claude.start.mutationOptions({
      onSuccess: () => {
        setSubscribing(true);
        queryClient.invalidateQueries({ queryKey: trpc.claude.status.queryKey({ cardId }) });
        moveMutation.mutate({ id: cardId, column: 'in_progress', position: 0 });
      },
    })
  );

  // Send message mutation
  const sendMutation = useMutation(
    trpc.claude.sendMessage.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.claude.status.queryKey({ cardId }) });
      },
    })
  );

  // Stop mutation
  const stopMutation = useMutation(
    trpc.claude.stop.mutationOptions({
      onSuccess: () => {
        setSubscribing(false);
        queryClient.invalidateQueries({ queryKey: trpc.claude.status.queryKey({ cardId }) });
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
      },
    })
  );

  const shouldSubscribe = sessionActive || subscribing;

  // Invalidate cards when session completes (covers both manual start and auto-start)
  const prevStatus = useRef(sessionStatus);
  useEffect(() => {
    if (prevStatus.current !== sessionStatus) {
      prevStatus.current = sessionStatus;
      if (sessionStatus === 'completed' || sessionStatus === 'errored') {
        setSubscribing(false);
        queryClient.invalidateQueries({ queryKey: trpc.cards.list.queryKey() });
        if (sessionId) {
          queryClient.invalidateQueries({ queryKey: trpc.sessions.loadSession.queryKey({ sessionId }) });
        }
      }
    }
  }, [sessionStatus, queryClient, trpc, sessionId]);

  // Extract tool outputs for live streaming
  const extractToolOutputs = useCallback((msg: Record<string, unknown>) => {
    // handled by useMemo above for display, but we still need live messages in state
  }, []);

  useSubscription(
    trpc.claude.onMessage.subscriptionOptions(
      { cardId },
      {
        enabled: shouldSubscribe,
        onData: (evt) => {
          const tracked = evt as { data: Record<string, unknown>; id: number };
          if (seenIds.current.has(tracked.id)) return;
          seenIds.current.add(tracked.id);
          setLiveMessages((prev) => [...prev, tracked.data]);
        },
        onError: (err) => {
          console.error('Subscription error:', err);
          setSubscribing(false);
          queryClient.invalidateQueries({ queryKey: trpc.claude.status.queryKey({ cardId }) });
        },
      }
    )
  );

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Scroll to bottom on initial load of history
  useEffect(() => {
    if (historyData && historyData.length > 0 && liveMessages.length === 0) {
      // Use instant scroll for initial load
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [historyData, liveMessages.length]);

  const showCounters = promptsSent > 0 || turnsCompleted > 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 border-t border-gray-200 dark:border-gray-700">
      {/* Status bar — only shown when there's activity */}
      {(isStreaming || messages.length > 0) && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <StatusBadge status={startMutation.isPending ? 'starting' : sessionStatus} />
          {showCounters && (
            <span className="text-[11px] text-muted-foreground">
              {turnsCompleted}/{promptsSent} turns
            </span>
          )}
          {isStreaming && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-xs text-muted-foreground"
              onClick={() => stopMutation.mutate({ cardId })}
              disabled={stopMutation.isPending}
            >
              <Square className="size-3" />
              Stop
            </Button>
          )}
        </div>
      )}

      {/* Messages — scrollable middle area */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-3 py-2 space-y-1">
          {messages.map((msg, i) => (
            <MessageBlock key={i} message={msg} toolOutputs={toolOutputs} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {startMutation.isError && (
        <div className="px-3 pt-2 shrink-0">
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{startMutation.error.message}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* Prompt input — pinned to bottom */}
      <PromptInput
        cardId={cardId}
        isRunning={isStreaming}
        hasSession={!!sessionId}
        isPending={startMutation.isPending}
        onStart={(prompt) => startMutation.mutate({ cardId, prompt })}
        onSend={(message) => sendMutation.mutate({ cardId, message })}
        sendPending={sendMutation.isPending}
      />
    </div>
  );
}

// --- Status badge ---

function StatusBadge({ status }: { status: string }) {
  let variant: 'default' | 'secondary' | 'destructive' | 'outline';
  let label: string;

  switch (status) {
    case 'running':
    case 'starting':
      variant = 'default';
      label = status === 'starting' ? 'Starting...' : 'Running';
      break;
    case 'completed':
      variant = 'secondary';
      label = 'Completed';
      break;
    default:
      variant = 'destructive';
      label = 'Errored';
  }

  return (
    <Badge variant={variant} className="text-xs">
      {label}
    </Badge>
  );
}

// --- Prompt input ---

function PromptInput({
  cardId,
  isRunning,
  hasSession,
  isPending,
  onStart,
  onSend,
  sendPending,
}: {
  cardId: number;
  isRunning: boolean;
  hasSession: boolean;
  isPending: boolean;
  onStart: (prompt: string) => void;
  onSend: (message: string) => void;
  sendPending: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;

    // Use sendMessage for follow-ups (existing session), onStart for new sessions
    if (isRunning || hasSession) {
      onSend(trimmed);
    } else {
      onStart(trimmed);
    }
    setText('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  const disabled = isPending || sendPending || !text.trim();

  return (
    <form
      onSubmit={handleSubmit}
      className="flex gap-2 px-3 py-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0"
    >
      <Textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isRunning ? 'Send a follow-up message...' : 'Enter a prompt to start a session...'}
        rows={2}
        className="flex-1 resize-none"
      />
      <Button
        type="submit"
        size="sm"
        disabled={disabled}
        className="self-end"
      >
        <Send className="size-4" />
      </Button>
    </form>
  );
}
