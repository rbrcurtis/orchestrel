import { useState, useRef, useEffect, useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import { Send, Square, AlertCircle, ChevronDown, Paperclip } from 'lucide-react';
import { MessageBlock } from './MessageBlock';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import { Badge } from '~/components/ui/badge';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { ContextGauge } from './ContextGauge';
import { useSessionStore, useCardStore } from '~/stores/context';
import type { FileRef } from '../../src/shared/ws-protocol';

type Props = {
  cardId: number;
  sessionId?: string | null;
  autoStartPrompt?: string;
  accentColor?: string | null;
  model: 'sonnet' | 'opus';
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
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

export const SessionView = observer(function SessionView({
  cardId,
  sessionId,
  autoStartPrompt,
  accentColor,
  model,
  thinkingLevel,
}: Props) {
  const sessionStore = useSessionStore();
  const cardStore = useCardStore();

  const session = sessionStore.getSession(cardId);

  const sessionActive = session?.active ?? false;
  const sessionStatus = session?.status ?? 'completed';
  const promptsSent = session?.promptsSent ?? 0;
  const turnsCompleted = session?.turnsCompleted ?? 0;
  const liveMessages = session?.liveMessages ?? [];
  const history = session?.history ?? [];

  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [contextTokens, setContextTokens] = useState(0);
  const [contextWindow, setContextWindow] = useState(200_000);
  const [compacted, setCompacted] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Reset live state when switching cards
  useEffect(() => {
    setPendingPrompt(null);
    setStartError(null);
    setIsStarting(false);
    setContextTokens(0);
    setContextWindow(200_000);
    setCompacted(false);
  }, [cardId]);

  // Load session history when sessionId is available
  useEffect(() => {
    if (!sessionId) return;
    setHistoryLoading(true);
    sessionStore.loadHistory(cardId, sessionId).finally(() => setHistoryLoading(false));
  }, [cardId, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Request status on mount
  useEffect(() => {
    sessionStore.requestStatus(cardId);
  }, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isStreaming = sessionActive || isStarting;

  // Merge: history + optimistic pending prompt + live messages
  const messages = useMemo(() => {
    const result = [...history] as Record<string, unknown>[];
    if (pendingPrompt) {
      result.push({ type: 'user', message: { role: 'user', content: pendingPrompt } });
    }
    result.push(...(liveMessages as Record<string, unknown>[]));
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

  function addOptimisticUser(text: string) {
    setPendingPrompt(text);
  }

  // Auto-start session when mounted with autoStartPrompt
  useEffect(() => {
    if (autoStartPrompt) {
      addOptimisticUser(autoStartPrompt);
      setIsStarting(true);
      setStartError(null);
      cardStore.moveCard({ id: cardId, column: 'in_progress', position: 0 });
      sessionStore.startSession(cardId, autoStartPrompt).catch((err) => {
        setStartError(err instanceof Error ? err.message : String(err));
        setIsStarting(false);
      });
    }
  }, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear pending prompt once live messages arrive
  const prevLiveLen = useRef(0);
  useEffect(() => {
    if (liveMessages.length > prevLiveLen.current && pendingPrompt) {
      setPendingPrompt(null);
    }
    prevLiveLen.current = liveMessages.length;
  }, [liveMessages.length, pendingPrompt]);

  // Clear pending prompt and isStarting when session becomes non-streaming
  const prevStatus = useRef(sessionStatus);
  useEffect(() => {
    if (prevStatus.current !== sessionStatus) {
      prevStatus.current = sessionStatus;
      if (sessionStatus === 'completed' || sessionStatus === 'errored' || sessionStatus === 'stopped') {
        setIsStarting(false);
        setPendingPrompt(null);
      }
    }
  }, [sessionStatus]);

  // Extract context tokens from live messages as they arrive
  useEffect(() => {
    if (liveMessages.length === 0) return;
    const last = liveMessages[liveMessages.length - 1] as Record<string, unknown>;
    const ctx = extractContextFromAssistant(last);
    if (ctx > 0) setContextTokens(ctx);
    const cw = extractContextWindow(last);
    if (cw > 0) setContextWindow(cw);
    if (last.type === 'system' && (last as { subtype?: string }).subtype === 'compact_boundary') {
      setCompacted(true);
      setTimeout(() => setCompacted(false), 600);
    }
  }, [liveMessages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom when new live messages or pending prompt arrive (only if near bottom)
  useEffect(() => {
    if (liveMessages.length === 0 && !pendingPrompt) return;
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveMessages.length, pendingPrompt]);

  // Scroll to bottom on initial load of history
  useEffect(() => {
    if (history.length > 0 && liveMessages.length === 0) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [history.length, liveMessages.length]);

  // Show/hide scroll-to-bottom button based on scroll position
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setShowScrollBtn(!nearBottom);
    }
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [messages.length]);

  // Extract initial context tokens from history
  useEffect(() => {
    if (!history || history.length === 0) return;
    let foundTokens = false;
    let foundWindow = false;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i] as Record<string, unknown>;
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
  }, [history]);

  const showCounters = promptsSent > 0 || turnsCompleted > 0;
  const contextPercent = contextWindow > 0 ? Math.min(100, contextTokens / contextWindow * 100) : 0;

  async function handleStart(prompt: string) {
    addOptimisticUser(prompt);
    setIsStarting(true);
    setStartError(null);
    cardStore.moveCard({ id: cardId, column: 'in_progress', position: 0 });
    try {
      await sessionStore.startSession(cardId, prompt);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
      setIsStarting(false);
    }
  }

  async function handleSend(message: string, files?: FileRef[]) {
    addOptimisticUser(message);
    cardStore.moveCard({ id: cardId, column: 'in_progress', position: 0 });
    await sessionStore.sendMessage(cardId, message, files);
  }

  async function handleStop() {
    await sessionStore.stopSession(cardId);
    setIsStarting(false);
  }

  async function handleUpdateCard(data: { model?: 'sonnet' | 'opus'; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' }) {
    await cardStore.updateCard({ id: cardId, ...data });
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 max-w-full border-t border-border">
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

      {startError && (
        <div className="px-3 pt-2 shrink-0">
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{startError}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* Status bar — above prompt input */}
      {(isStreaming || messages.length > 0) && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted border-t border-border shrink-0">
          <StatusBadge status={isStarting && sessionStatus !== 'running' ? 'starting' : sessionStatus} />
          {showCounters && (
            <span className="text-[11px] text-muted-foreground">
              {turnsCompleted}/{promptsSent} turns
            </span>
          )}
          <select
            value={model}
            onChange={(e) => handleUpdateCard({ model: e.target.value as 'sonnet' | 'opus' })}
            className="text-[11px] bg-transparent text-muted-foreground border-none outline-none cursor-pointer hover:text-foreground"
          >
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
          </select>
          <select
            value={thinkingLevel}
            onChange={(e) => handleUpdateCard({ thinkingLevel: e.target.value as 'off' | 'low' | 'medium' | 'high' })}
            className="text-[11px] bg-transparent text-muted-foreground border-none outline-none cursor-pointer hover:text-foreground"
          >
            <option value="off">Off</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          {isStreaming && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-xs text-muted-foreground"
              onClick={handleStop}
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
        isPending={isStarting}
        onStart={handleStart}
        onSend={handleSend}
        sendPending={false}
        contextPercent={contextPercent}
        compacted={compacted}
      />
    </div>
  );
});

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
    try { if (val) localStorage.setItem(storageKey, val); else localStorage.removeItem(storageKey); } catch { /* localStorage unavailable */ }
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
