import { useState, useRef, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { Send, Square, Play, AlertCircle, ChevronDown, Paperclip, X, WifiOff } from 'lucide-react';
import { MessageBlock } from './MessageBlock';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/textarea';
import { Badge } from '~/components/ui/badge';
import { ContextGauge } from './ContextGauge';
import { SubagentFeed } from './SubagentFeed';
import { ScrollArea } from '~/components/ui/scroll-area';
import { useSessionStore, useCardStore, useConfigStore, useStore } from '~/stores/context';
import type { FileRef } from '../../src/shared/ws-protocol';
import { AUTO_COMPACT_RATIO } from '../../src/shared/constants';

type Props = {
  cardId: number;
  sessionId?: string | null;
  accentColor?: string | null;
  model: string;
  providerID: string;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
};

export const SessionView = observer(function SessionView({
  cardId,
  sessionId,
  accentColor,
  model,
  providerID,
  thinkingLevel,
}: Props) {
  const sessionStore = useSessionStore();
  const cardStore = useCardStore();
  const config = useConfigStore();

  const session = sessionStore.getSession(cardId);
  const card = cardStore.getCard(cardId);
  const conversation = session?.accumulator.conversation ?? [];
  const currentBlocks = session?.accumulator.currentBlocks ?? [];
  const sessionActive = session?.active ?? false;
  const sessionStatus = session?.status ?? 'completed';
  const promptsSent = session?.promptsSent ?? 0;
  const turnsCompleted = session?.turnsCompleted ?? 0;
  const sessionStoreId = session?.sessionId ?? null;
  const contextTokens = session?.contextTokens || card?.contextTokens || 0;
  const contextWindow = session?.contextWindow || card?.contextWindow || 200_000;
  const subagents = session?.accumulator.subagents ?? new Map();

  const isStopping = sessionStore.stoppingCards.has(cardId);

  const [notification, setNotification] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevConvLen = useRef(0);
  const nearBottomRef = useRef(true); // tracks if user is near bottom (for auto-scroll gating)
  const isStreamingRef = useRef(false); // mirrors isStreaming for ResizeObserver access
  const [compacted, setCompacted] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);

  const isStreaming = sessionActive || isStarting;
  isStreamingRef.current = isStreaming;

  // Load history / set up bus subscriptions on mount and when sessionId becomes available.
  // Called without sessionId on first render to register card-level bus subscriptions
  // immediately (avoiding the race where messages arrive before sessionId is known).
  // Called again once sessionId is available to actually load history.
  useEffect(() => {
    const sid = sessionStoreId ?? sessionId;
    if (sid && session?.historyLoaded) return; // history already loaded — nothing to do
    sessionStore.loadHistory(cardId, sid ?? undefined);
  }, [cardId, sessionStoreId, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Request status on mount
  useEffect(() => {
    sessionStore.requestStatus(cardId);
  }, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Card switch reset
  useEffect(() => {
    setNotification(null);
    setIsStarting(false);
    setCompacted(false);
    prevConvLen.current = 0; // ensure scroll-to-bottom fires for the new card
  }, [cardId]);

  // Clear isStarting on status transition
  useEffect(() => {
    if (
      sessionStatus === 'running' ||
      sessionStatus === 'completed' ||
      sessionStatus === 'errored' ||
      sessionStatus === 'stopped' ||
      sessionStatus === 'retry'
    ) {
      setIsStarting(false);
    }
  }, [sessionStatus]);

  // Show notification when session errors
  useEffect(() => {
    if (sessionStatus === 'errored') {
      const last = conversation.findLast((m) => m.kind === 'error');
      if (last && last.kind === 'error') setNotification(last.message);
    } else {
      setNotification(null);
    }
  }, [sessionStatus, conversation.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ResizeObserver-based auto-scroll: fires after DOM layout changes.
  // Computes near-bottom inline (scroll events are async and may be stale).
  useEffect(() => {
    const content = contentRef.current;
    const scroll = scrollRef.current;
    if (!content || !scroll) return;

    let prevHeight = content.scrollHeight;
    let initialScroll = true;
    let rafId = 0;

    const ro = new ResizeObserver(() => {
      const newHeight = content.scrollHeight;
      if (newHeight <= prevHeight) {
        prevHeight = newHeight;
        return;
      }

      prevHeight = newHeight;

      if (rafId) cancelAnimationFrame(rafId);

      // Only auto-scroll when the session is actively streaming
      // (new messages or streaming text/tool output), not when the user
      // toggles a collapsible tool block which resizes content in-place.
      if (initialScroll || (isStreamingRef.current && nearBottomRef.current)) {
        initialScroll = false;
        rafId = requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: 'instant' });
          rafId = 0;
        });
      }
    });

    ro.observe(content);
    return () => {
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [cardId]);

  // Track scroll position for near-bottom gating + scroll-to-bottom button
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      nearBottomRef.current = gap < 120;
      setShowScrollBtn(gap >= 60);
    }
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [cardId]);

  // Compaction detection
  useEffect(() => {
    const len = conversation.length;
    if (len === 0) {
      prevConvLen.current = 0;
      return;
    }
    const last = conversation[len - 1];
    if (last.kind === 'compact') {
      setCompacted(true);
      setTimeout(() => setCompacted(false), 600);
    }
    prevConvLen.current = len;
  }, [conversation.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Card switch: reset near-bottom so next content triggers instant scroll,
  // and scroll to bottom immediately if conversation is already loaded
  useEffect(() => {
    nearBottomRef.current = true;
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    });
  }, [cardId]);

  // After reconnect history reload: scroll to bottom once history re-ingests.
  // historyLoaded transitions false→true when resubscribeAll clears + reloads.
  const historyLoaded = session?.historyLoaded ?? false;
  useEffect(() => {
    if (historyLoaded && conversation.length > 0) {
      nearBottomRef.current = true;
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'instant' });
      });
    }
  }, [historyLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const showCounters = promptsSent > 0 || turnsCompleted > 0;
  const effectiveWindow = contextWindow * AUTO_COMPACT_RATIO;
  const contextPercent = effectiveWindow > 0 ? Math.min(100, (contextTokens / effectiveWindow) * 100) : 0;
  const retryAfterMs = session?.accumulator.retryAfterMs ?? null;
  const retryInfo = sessionStatus === 'retry' && retryAfterMs != null
    ? { retryAfterMs }
    : null;

  async function handleSend(message: string, files?: FileRef[]) {
    try {
      await sessionStore.sendMessage(cardId, message, files);
    } catch (err) {
      setNotification(err instanceof Error ? err.message : String(err));
    }
  }

  function handleStop() {
    sessionStore.stopSession(cardId);
    setIsStarting(false);
  }

  async function handleUpdateCard(data: { model?: string; provider?: string; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' }) {
    await cardStore.updateCard({ id: cardId, ...data });
  }

  function handlePanelMouseDown(e: React.MouseEvent) {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
  }

  function handlePanelClick(e: React.MouseEvent) {
    if (e.detail !== 1) return; // only single clicks — let double/triple clicks select text
    const down = mouseDownPos.current;
    mouseDownPos.current = null;
    if (!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (dx * dx + dy * dy > 25) return; // dragged > 5px — skip
    const target = e.target as HTMLElement;
    if (target.closest('button, a, select, input, textarea, [role="button"], [data-interactive]')) return;
    textareaRef.current?.focus();
  }

  return (
    <div
      className="flex flex-col flex-1 min-h-0 min-w-0 max-w-full border-t border-border"
      onMouseDown={handlePanelMouseDown}
      onClick={handlePanelClick}
    >
      {/* Messages — scrollable middle area */}
      <div className="relative flex-1 min-h-0 min-w-0">
        <ScrollArea viewportRef={scrollRef} className="h-full">
          <div ref={contentRef} className="px-3 py-2 space-y-1 min-w-0 max-w-full overflow-x-hidden">
            {conversation.map((row, i) => (
              <MessageBlock key={i} entry={row} index={i} accentColor={accentColor} />
            ))}
            {currentBlocks.length > 0 && (
              <MessageBlock
                entry={{ kind: 'blocks', blocks: currentBlocks }}
                index={conversation.length}
                accentColor={accentColor}
              />
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
        {!session?.historyLoaded && conversation.length === 0 && (
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

      {/* Status bar — above prompt input */}
      {(isStreaming || conversation.length > 0) && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted border-t border-border shrink-0 min-w-0 overflow-hidden">
          <StatusBadge
            status={isStarting && sessionStatus !== 'running' ? 'starting' : sessionStatus}
          />
          {retryInfo && (
            <span className="text-[11px] text-neon-amber truncate min-w-0">
              Rate limited — retrying in {Math.ceil(retryInfo.retryAfterMs / 1000)}s
            </span>
          )}
          {showCounters && (
            <span className="text-[11px] text-muted-foreground shrink-0">
              {turnsCompleted}/{promptsSent} turns
            </span>
          )}
          <select
            value={providerID}
            onChange={(e) => {
              const newProvider = e.target.value;
              const models = config.getModels(newProvider);
              const defaultModel = models.length > 0 ? models[0][0] : 'sonnet';
              handleUpdateCard({ provider: newProvider, model: defaultModel });
            }}
            className="text-[11px] bg-transparent text-muted-foreground border-none outline-none cursor-pointer hover:text-foreground min-w-0 truncate"
          >
            {config.allProviders.map(([id, p]) => (
              <option key={id} value={id}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            value={model}
            onChange={(e) => handleUpdateCard({ model: e.target.value })}
            className="text-[11px] bg-transparent text-muted-foreground border-none outline-none cursor-pointer hover:text-foreground min-w-0 truncate"
          >
            {config.getModels(providerID).map(([alias, m]) => (
              <option key={alias} value={alias}>
                {m.label}
              </option>
            ))}
          </select>
          <select
            value={thinkingLevel}
            onChange={(e) => handleUpdateCard({ thinkingLevel: e.target.value as 'off' | 'low' | 'medium' | 'high' })}
            className="text-[11px] bg-transparent text-muted-foreground border-none outline-none cursor-pointer hover:text-foreground min-w-0"
          >
            <option value="off">Off</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          {isStreaming ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-xs text-muted-foreground"
              onClick={handleStop}
              disabled={isStopping}
            >
              <Square className="size-3 fill-current" />
              {isStopping ? 'Stopping...' : 'Stop'}
            </Button>
          ) : sessionId ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-xs text-muted-foreground"
              onClick={() => handleSend('Continue')}
            >
              <Play className="size-3 fill-current" />
              Continue
            </Button>
          ) : null}
        </div>
      )}

      {/* Subagent activity feed */}
      <SubagentFeed subagents={subagents} />

      {/* Error notification */}
      <SessionNotification message={notification} onDismiss={() => setNotification(null)} />

      {/* Prompt input — pinned to bottom */}
      <PromptInput
        cardId={cardId}
        isRunning={isStreaming}
        hasSession={!!sessionId || sessionActive}
        isPending={isStarting}
        onSend={handleSend}
        onStop={handleStop}
        onCompact={!!sessionId || sessionActive ? () => sessionStore.compactSession(cardId) : undefined}
        sendPending={false}
        contextPercent={contextPercent}
        compacted={compacted}
        textareaRef={textareaRef}
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
    case 'stopped':
      variant = 'secondary';
      label = 'Completed';
      break;
    case 'retry':
      variant = 'outline';
      label = 'Retrying...';
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

// --- Session notification ---

function SessionNotification({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="mx-3 my-1.5 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive shrink-0">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1 break-words">{message}</span>
      <button type="button" onClick={onDismiss} className="shrink-0 hover:opacity-70">
        <X className="size-4" />
      </button>
    </div>
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
  onSend,
  onStop,
  onCompact,
  sendPending,
  contextPercent,
  compacted,
  textareaRef,
}: {
  cardId: number;
  isRunning: boolean;
  hasSession: boolean;
  isPending: boolean;
  onSend: (message: string, files?: FileRef[]) => void;
  onStop: () => void;
  onCompact?: () => void;
  sendPending: boolean;
  contextPercent: number;
  compacted: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const storageKey = `prompt-draft-${cardId}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const [files, setFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? localRef;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync text to localStorage on every change
  function updateText(val: string) {
    setText(val);
    try {
      if (val) localStorage.setItem(storageKey, val);
      else localStorage.removeItem(storageKey);
    } catch {
      /* localStorage unavailable */
    }
  }

  // Reload draft when switching cards
  useEffect(() => {
    try {
      setText(localStorage.getItem(storageKey) ?? '');
    } catch {
      setText('');
    }
  }, [storageKey]);

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
    updateText('');
    setFiles([]);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && isRunning) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === 'c' && e.ctrlKey && !e.shiftKey && !e.metaKey) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        e.preventDefault();
        updateText('');
        setFiles([]);
      }
      return;
    }
    if (e.key === 'w' && e.ctrlKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      const ta = ref.current;
      if (!ta) return;
      const pos = ta.selectionStart;
      const before = text.slice(0, pos);
      // Skip trailing whitespace, then delete word chars
      const m = before.match(/(\S+\s*)$/);
      const del = m ? m[1].length : 0;
      if (del > 0) {
        const next = text.slice(0, pos - del) + text.slice(pos);
        updateText(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = pos - del;
        });
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  // Track WS connection state for reconnect button
  const { ws: wsClient } = useStore();
  const [wsConnected, setWsConnected] = useState(wsClient.connected);
  useEffect(() => {
    // Poll connection state — WsClient.connected isn't MobX-observable
    const id = setInterval(() => setWsConnected(wsClient.connected), 500);
    const onVis = () => setWsConnected(wsClient.connected);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [wsClient]);

  const disabled = isPending || sendPending || (!text.trim() && files.length === 0);

  return (
    <form
      onSubmit={handleSubmit}
      className="px-3 py-2 border-t border-border bg-muted shrink-0"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
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
        <div className="text-xs text-destructive mb-1 text-right pr-[46px] sm:pr-[38px]">{uploadError}</div>
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
            className="resize-none min-h-full pr-10 focus-ring"
          />
          {/* Reconnect button - top right inside textarea, only when disconnected */}
          {!wsConnected && (
            <button
              type="button"
              onClick={() => wsClient.forceReconnect()}
              className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded-md bg-destructive/15 text-destructive text-xs font-medium hover:bg-destructive/25 transition-colors"
              title="WebSocket disconnected — tap to reconnect"
            >
              <WifiOff className="size-3" />
              Reconnect
            </button>
          )}
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
        <div className="flex flex-col items-center justify-end gap-1.5 shrink-0">
          <ContextGauge percent={contextPercent} compacted={compacted} onCompact={onCompact} />
          <Button type="submit" disabled={disabled} className="size-[50px] sm:size-[34px] p-0">
            <Send className="size-5 sm:size-4" />
          </Button>
        </div>
      </div>
    </form>
  );
}
