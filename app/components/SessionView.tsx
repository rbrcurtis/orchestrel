import { useState, useRef, useEffect, useMemo } from 'react';
import { Send, Square, AlertCircle, ChevronDown, Paperclip } from 'lucide-react';
import { useTRPC } from '~/lib/trpc';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { MessageBlock } from './MessageBlock';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import { Badge } from '~/components/ui/badge';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { ContextGauge } from './ContextGauge';

type Props = {
  cardId: number;
  sessionId?: string | null;
  accentColor?: string | null;
};

type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: Array<{ type: string; text: string }>;
};

/** Extract context fill from an assistant message's per-turn usage.
 *  Context = input_tokens + cache_creation_input_tokens + cache_read_input_tokens */
function extractContextFromAssistant(msg: Record<string, unknown>): number {
  if (msg.type !== 'assistant') return 0;
  if ((msg as { isSidechain?: boolean }).isSidechain) return 0;
  const message = msg.message as { usage?: Record<string, number> } | undefined;
  const usage = message?.usage;
  if (!usage) return 0;
  return (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
}

/** Extract context window size from a result message's modelUsage */
function extractContextWindow(msg: Record<string, unknown>): number {
  if (msg.type !== 'result') return 0;
  const modelUsage = msg.modelUsage as Record<string, Record<string, number>> | undefined;
  if (!modelUsage) return 0;
  const model = Object.values(modelUsage)[0];
  return model?.contextWindow ?? 0;
}

export function SessionView({ cardId, sessionId, accentColor }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: statusData } = useQuery({
    ...trpc.claude.status.queryOptions({ cardId }),
    refetchInterval: 3000,
  });

  // Load historical session messages when not actively streaming
  const { data: historyData, isLoading: historyLoading } = useQuery(
    trpc.sessions.loadSession.queryOptions(
      { sessionId: sessionId! },
      { enabled: !!sessionId },
    )
  );

  const [liveMessages, setLiveMessages] = useState<Record<string, unknown>[]>([]);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const seenIds = useRef(new Set<number>());
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [contextTokens, setContextTokens] = useState(0);
  const [contextWindow, setContextWindow] = useState(200_000);
  const [compacted, setCompacted] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Reset live state when switching cards
  useEffect(() => {
    setLiveMessages([]);
    setPendingPrompt(null);
    setSubscribing(false);
    seenIds.current.clear();
    setContextTokens(0);
    setContextWindow(200_000);
    setCompacted(false);
  }, [cardId]);

  const sessionActive = statusData?.active ?? false;
  const sessionStatus = statusData?.status ?? 'completed';
  const promptsSent = statusData?.promptsSent ?? 0;
  const turnsCompleted = statusData?.turnsCompleted ?? 0;

  const isStreaming = sessionActive || subscribing;
  const history = (historyData as Record<string, unknown>[] | undefined) ?? [];

  // Merge: history + optimistic pending prompt + live subscription data
  const messages = useMemo(() => {
    const result = [...history];
    if (pendingPrompt) {
      result.push({ type: 'user', message: { role: 'user', content: pendingPrompt } });
    }
    result.push(...liveMessages);
    return result;
  }, [history, liveMessages, pendingPrompt]);

  // Extract tool outputs from all messages
  const toolOutputs = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
      if (msg.type !== 'user') continue;
      const inner = msg.message as { content?: unknown } | undefined;
      if (!inner?.content || !Array.isArray(inner.content)) continue;

      for (const block of inner.content as ToolResultBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const text = Array.isArray(block.content)
            ? block.content.map((c) => c.text).filter(Boolean).join('\n')
            : typeof block.content === 'string' ? block.content : '';
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

  function addOptimisticUser(text: string) {
    setPendingPrompt(text);
    setLiveMessages([]);
    seenIds.current.clear();
  }

  // Start mutation
  const startMutation = useMutation(
    trpc.claude.start.mutationOptions({
      onMutate: ({ prompt }) => {
        addOptimisticUser(prompt);
        setSubscribing(true);
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.claude.status.queryKey({ cardId }) });
        moveMutation.mutate({ id: cardId, column: 'in_progress', position: 0 });
      },
    })
  );

  // Send message mutation — delay subscribing until server confirms
  // to avoid replaying messages from the previous query
  const sendMutation = useMutation(
    trpc.claude.sendMessage.mutationOptions({
      onMutate: ({ message }) => {
        addOptimisticUser(message);
      },
      onSuccess: () => {
        setSubscribing(true);
        queryClient.invalidateQueries({ queryKey: trpc.claude.status.queryKey({ cardId }) });
        moveMutation.mutate({ id: cardId, column: 'in_progress', position: 0 });
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

  // Clean up stale live data on streaming → idle transition
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) {
      setLiveMessages([]);
      setPendingPrompt(null);
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

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

  useSubscription(
    trpc.claude.onMessage.subscriptionOptions(
      { cardId },
      {
        enabled: shouldSubscribe,
        onData: (evt) => {
          const tracked = evt as { data: Record<string, unknown>; id: number };
          if (seenIds.current.has(tracked.id)) return;
          seenIds.current.add(tracked.id);
          // Clear optimistic prompt once real data arrives (server now emits the user message)
          setPendingPrompt(null);
          setLiveMessages((prev) => [...prev, tracked.data]);

          const msg = tracked.data;
          // Extract context fill from assistant messages (per-turn usage)
          const ctx = extractContextFromAssistant(msg);
          if (ctx > 0) setContextTokens(ctx);
          // Extract context window size from result messages
          const cw = extractContextWindow(msg);
          if (cw > 0) setContextWindow(cw);
          if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'compact_boundary') {
            setCompacted(true);
            setTimeout(() => setCompacted(false), 600);
          }
        },
        onError: (err) => {
          console.error('Subscription error:', err);
          setSubscribing(false);
          queryClient.invalidateQueries({ queryKey: trpc.claude.status.queryKey({ cardId }) });
        },
      }
    )
  );

  // Auto-scroll to bottom when new live messages or pending prompt arrive (only if near bottom)
  useEffect(() => {
    if (liveMessages.length === 0 && !pendingPrompt) return;
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveMessages, pendingPrompt]);

  // Scroll to bottom on initial load of history
  useEffect(() => {
    if (historyData && historyData.length > 0 && liveMessages.length === 0) {
      // Use instant scroll for initial load
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [historyData, liveMessages.length]);

  // Show/hide scroll-to-bottom button based on scroll position
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setShowScrollBtn(!nearBottom);
    }
    onScroll(); // check initial position
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [messages.length]);

  // Extract initial context tokens from history
  useEffect(() => {
    if (!historyData || historyData.length === 0) return;
    let foundTokens = false;
    let foundWindow = false;
    for (let i = historyData.length - 1; i >= 0; i--) {
      const msg = historyData[i] as Record<string, unknown>;
      if (!foundTokens) {
        const ctx = extractContextFromAssistant(msg);
        if (ctx > 0) { setContextTokens(ctx); foundTokens = true; }
      }
      if (!foundWindow) {
        const cw = extractContextWindow(msg);
        if (cw > 0) { setContextWindow(cw); foundWindow = true; }
      }
      if (foundTokens && foundWindow) return;
    }
  }, [historyData]);

  const showCounters = promptsSent > 0 || turnsCompleted > 0;
  const contextPercent = contextWindow > 0 ? Math.min(100, contextTokens / contextWindow * 100) : 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 max-w-full border-t border-border">
      {/* Status bar — only shown when there's activity */}
      {/* Messages — scrollable middle area */}
      <div className="relative flex-1 min-h-0 min-w-0">
        <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-hidden">
          <div className="px-3 py-2 space-y-1 min-w-0">
            {messages.map((msg, i) => (
              <MessageBlock key={i} message={msg} toolOutputs={toolOutputs} accentColor={accentColor} />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
        {historyLoading && messages.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <svg className="size-6 animate-spin text-muted-foreground" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        )}
        {showScrollBtn && (
          <button
            type="button"
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
            className="absolute bottom-3 right-3 size-8 flex items-center justify-center rounded-full bg-muted/80 border border-border text-muted-foreground shadow-md backdrop-blur-sm hover:bg-muted hover:text-foreground transition-colors"
          >
            <ChevronDown className="size-4" />
          </button>
        )}
      </div>

      {startMutation.isError && (
        <div className="px-3 pt-2 shrink-0">
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{startMutation.error.message}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* Status bar — above prompt input */}
      {(isStreaming || messages.length > 0) && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted border-t border-border shrink-0">
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
              <Square className="size-3 fill-current" />
              Stop
            </Button>
          )}
        </div>
      )}

      {/* Prompt input — pinned to bottom */}
      <PromptInput
        cardId={cardId}
        isRunning={isStreaming}
        hasSession={!!sessionId}
        isPending={startMutation.isPending}
        onStart={(prompt) => startMutation.mutate({ cardId, prompt })}
        onSend={(message, files) => sendMutation.mutate({ cardId, message, files })}
        sendPending={sendMutation.isPending}
        contextPercent={contextPercent}
        compacted={compacted}
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

// --- File upload helpers ---

type FileRef = {
  id: string;
  name: string;
  mimeType: string;
  path: string;
  size: number;
};

async function uploadFiles(files: File[], sessionId?: string): Promise<FileRef[]> {
  const form = new FormData();
  if (sessionId) form.append('sessionId', sessionId);
  for (const f of files) form.append('files', f);

  const res = await fetch('/api/upload', { method: 'POST', body: form });
  if (!res.ok) throw new Error('Upload failed');
  const data = await res.json();
  return data.files;
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
  contextPercent,
  compacted,
}: {
  cardId: number;
  isRunning: boolean;
  hasSession: boolean;
  isPending: boolean;
  onStart: (prompt: string) => void;
  onSend: (message: string, files?: FileRef[]) => void;
  sendPending: boolean;
  contextPercent: number;
  compacted: boolean;
}) {
  const storageKey = `prompt-draft-${cardId}`;
  const [text, setText] = useState(() => {
    try { return localStorage.getItem(storageKey) ?? ''; } catch { return ''; }
  });
  const [files, setFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync text to localStorage on every change
  function updateText(val: string) {
    setText(val);
    try { if (val) localStorage.setItem(storageKey, val); else localStorage.removeItem(storageKey); } catch {}
  }

  // Reload draft when switching cards
  useEffect(() => {
    try { setText(localStorage.getItem(storageKey) ?? ''); } catch { setText(''); }
  }, [storageKey]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  function addFiles(newFiles: FileList | File[]) {
    const arr = Array.from(newFiles).filter((f) => f.size <= 25 * 1024 * 1024);
    setFiles((prev) => [...prev, ...arr]);
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  function handlePaste(e: React.ClipboardEvent) {
    if (!isRunning && !hasSession) return;
    const items = Array.from(e.clipboardData.items);
    const imageFiles = items
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (imageFiles.length > 0) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!isRunning && !hasSession) return;
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;

    setUploadError(null);
    if (isRunning || hasSession) {
      if (files.length > 0) {
        try {
          const refs = await uploadFiles(files);
          onSend(trimmed || 'Please review the attached files.', refs);
        } catch {
          setUploadError('Failed to upload files');
          return;
        }
      } else {
        onSend(trimmed);
      }
    } else {
      onStart(trimmed);
    }
    updateText('');
    setFiles([]);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  const disabled = isPending || sendPending || (!text.trim() && files.length === 0);

  return (
    <form
      onSubmit={handleSubmit}
      className="px-3 py-2 border-t border-border bg-muted shrink-0"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {/* File chips row - right aligned, left of stop button area */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2 justify-end pr-[46px] sm:pr-[38px]">
          {files.map((f, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-elevated text-xs text-muted-foreground border border-border"
            >
              <span className="max-w-[120px] truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => removeFile(i)}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {uploadError && (
        <div className="text-xs text-destructive mb-1 text-right pr-[46px] sm:pr-[38px]">
          {uploadError}
        </div>
      )}
      <div className={`flex gap-2 ${dragging ? 'ring-2 ring-neon-cyan/50 rounded-md' : ''}`}>
        <div className="relative flex-1">
          <Textarea
            ref={ref}
            value={text}
            onChange={(e) => updateText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isRunning ? 'Send a follow-up message...' : 'Enter a prompt to start a session...'}
            maxLength={10000}
            rows={3}
            className="resize-none min-h-full pr-10"
          />
          {/* Paperclip button - bottom right inside textarea */}
          {(isRunning || hasSession) && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="absolute bottom-2 right-2 text-muted-foreground hover:text-foreground transition-colors"
              title="Attach files"
            >
              <Paperclip className="size-4" />
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        <div className="flex flex-col items-center justify-end gap-1.5">
          <ContextGauge
            percent={contextPercent}
            compacted={compacted}
            onCompact={hasSession ? () => onSend('/compact') : undefined}
          />
          <Button
            type="submit"
            disabled={disabled}
            className="size-[50px] sm:size-[34px] p-0"
          >
            <Send className="size-5 sm:size-4" />
          </Button>
        </div>
      </div>
    </form>
  );
}
