import { makeAutoObservable, observable, runInAction } from 'mobx';
import type { AgentMessage, AgentStatus, FileRef } from '../../src/shared/ws-protocol';
import type { WsClient } from '../lib/ws-client';
import { uuid } from '../lib/utils';
import { contentHashSync } from '../lib/content-hash';

let _ws: WsClient | null = null;

export function setSessionStoreWs(ws: WsClient) {
  _ws = ws;
}

function ws(): WsClient {
  if (!_ws) throw new Error('WsClient not set');
  return _ws;
}

export interface ConversationRow extends AgentMessage {
  id: string; // content hash for dedup
  optimistic?: boolean;
}

export interface SessionState {
  active: boolean;
  status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped' | 'retry';
  sessionId: string | null;
  promptsSent: number;
  turnsCompleted: number;
  conversation: ConversationRow[];
  toolCallIdxMap: Map<string, number>; // toolCall.id → conversation index for in-place update
  historyLoaded: boolean; // true after first history load
  contextTokens: number;
  contextWindow: number;
  subagents: Map<string, { title: string; lastActivity: string; status: 'running' | 'idle' }>;
  activeTextIdx: number | null; // index of current open text block for delta accumulation
  activeThinkingIdx: number | null; // index of current open thinking block for delta accumulation
  conversationIds: Set<string>; // content hashes for dedup
}

function extractContextTokens(msg: AgentMessage): number | null {
  if ((msg.type !== 'text' && msg.type !== 'turn_end') || !msg.usage || msg.meta?.isSidechain) return null;
  const u = msg.usage;
  return (u.inputTokens ?? 0) + (u.cacheWrite ?? 0) + (u.cacheRead ?? 0);
}

function defaultSession(): SessionState {
  return {
    active: false,
    status: 'stopped',
    sessionId: null,
    promptsSent: 0,
    turnsCompleted: 0,
    conversation: observable.array([], { deep: true }),
    toolCallIdxMap: new Map(),
    historyLoaded: false,
    contextTokens: 0,
    contextWindow: 200_000,
    subagents: observable.map(),
    activeTextIdx: null,
    activeThinkingIdx: null,
    conversationIds: new Set(),
  };
}

/** Find insertion index to maintain timestamp sort order (insert after equal timestamps). */
function findSortedInsertIdx(conversation: ConversationRow[], timestamp: number): number {
  // Walk backward from end — most inserts are at or near the tail
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i].timestamp <= timestamp) return i + 1;
  }
  return 0;
}

/** Rebuild the toolCall.id → conversation index map from scratch. */
function rebuildToolCallIdxMap(s: SessionState): void {
  s.toolCallIdxMap.clear();
  for (let i = 0; i < s.conversation.length; i++) {
    const row = s.conversation[i];
    if (row.type === 'tool_call' && row.toolCall?.id) {
      s.toolCallIdxMap.set(row.toolCall.id, i);
    }
  }
}

export class SessionStore {
  sessions = observable.map<number, SessionState>();
  subscribedCards = new Set<number>();
  stoppingCards = observable.set<number>();
  private subagentTimeouts = new Map<string, NodeJS.Timeout>();
  private stopIntervals = new Map<number, NodeJS.Timeout>();

  constructor() {
    makeAutoObservable<this, 'subagentTimeouts' | 'stopIntervals'>(this, {
      subagentTimeouts: false,
      stopIntervals: false,
    });
  }

  private getOrCreate(cardId: number): SessionState {
    if (!this.sessions.has(cardId)) {
      this.sessions.set(cardId, defaultSession());
    }
    return this.sessions.get(cardId)!;
  }

  getSession(cardId: number): SessionState | undefined {
    return this.sessions.get(cardId);
  }

  // ── Incoming server messages ────────────────────────────────────────────────

  /**
   * Ingest a single message (live stream or optimistic send).
   * Hashes content for dedup — if already in conversation, skips silently.
   * Timestamp is excluded from hash (varies between history/live).
   *
   * tool_call messages arrive twice from OpenCode: first with empty params {},
   * then with the full params. We dedup by toolCall.id and replace in-place
   * when the newer message has richer params, so no duplicate rows appear.
   */
  ingest(cardId: number, msg: AgentMessage): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId);

      // If content arrives for a session we think is inactive, flip it back.
      // The agent is still producing output (e.g., stop didn't take effect yet).
      if (!s.active && (msg.type === 'text' || msg.type === 'tool_call' || msg.type === 'thinking')) {
        s.active = true;
        s.status = 'running';
      }

      if (msg.type === 'subagent' && msg.meta) {
        const m = msg.meta as {
          subtype: string;
          childSessionId: string;
          title: string;
          tool?: string;
          target?: string;
        };
        if (m.subtype === 'activity') {
          s.subagents.set(m.childSessionId, {
            title: m.title,
            lastActivity: `${m.tool} → ${m.target}`,
            status: 'running',
          });
        } else if (m.subtype === 'completed') {
          const existing = s.subagents.get(m.childSessionId);
          if (existing) {
            existing.status = 'idle';
            existing.lastActivity = 'done';
          }
          // Schedule removal after 2s
          const timeoutKey = `${cardId}:${m.childSessionId}`;
          const prev = this.subagentTimeouts.get(timeoutKey);
          if (prev) clearTimeout(prev);
          this.subagentTimeouts.set(
            timeoutKey,
            setTimeout(() => {
              runInAction(() => {
                s.subagents.delete(m.childSessionId);
              });
              this.subagentTimeouts.delete(timeoutKey);
            }, 2000),
          );
        }
        return; // Don't add subagent messages to conversation
      }

      const { timestamp, ...stable } = msg;
      const id = contentHashSync(msg.type, stable);

      if (s.conversationIds.has(id)) return;
      s.conversationIds.add(id);

      // Server echo for a user message — confirm the optimistic row.
      // Use endsWith for matching: when files are attached the server prepends
      // a file-list prefix to the prompt, so the echo content is longer than
      // the original optimistic message.
      if (msg.type === 'user' && !msg.meta?.optimistic) {
        const idx = s.conversation.findLastIndex(
          (r) => r.type === 'user' && r.optimistic && (r.content === msg.content || msg.content.endsWith(r.content)),
        );
        if (idx !== -1) {
          s.conversation[idx] = { ...s.conversation[idx], content: msg.content, optimistic: false };
          return;
        }
      }

      // Block-closing events: reset active text/thinking indices
      if (
        msg.type === 'turn_end' ||
        msg.type === 'tool_call' ||
        msg.type === 'user' ||
        msg.type === 'error' ||
        (msg.type === 'system' && (msg.meta as { subtype?: string } | undefined)?.subtype === 'init')
      ) {
        s.activeTextIdx = null;
        s.activeThinkingIdx = null;
      }

      // Delta accumulation for text and thinking
      if (msg.type === 'text' || msg.type === 'thinking') {
        const activeIdx = msg.type === 'text' ? s.activeTextIdx : s.activeThinkingIdx;
        if (activeIdx !== null) {
          // Append delta to existing row — skip dedup, mutate in place
          s.conversation[activeIdx].content += msg.content ?? '';
          const tokens = extractContextTokens(msg);
          if (tokens !== null) s.contextTokens = tokens;
          return;
        }
        // No active block — fall through to push a new row and record its index
      }

      if (msg.type === 'tool_call' && msg.toolCall?.id) {
        const existingIdx = s.toolCallIdxMap.get(msg.toolCall.id);
        if (existingIdx !== undefined) {
          const existing = s.conversation[existingIdx];
          const existingParamCount = Object.keys(existing.toolCall?.params ?? {}).length;
          const newParamCount = Object.keys(msg.toolCall.params ?? {}).length;
          const hasNewStreaming = !!msg.toolCall.streamingOutput;
          if (newParamCount > existingParamCount || hasNewStreaming) {
            s.conversation.splice(existingIdx, 1, { ...msg, id });
          }
          return; // Either replaced or kept existing — never append a duplicate
        }
      }

      const row: ConversationRow = { ...msg, id };
      if (msg.meta?.optimistic) row.optimistic = true;

      // Sorted insert by timestamp: find the last item with timestamp <= this
      // message's timestamp and insert after it. This ensures messages from
      // the same logical moment (e.g., tool_call and tool_result sharing
      // part.time.start) stay grouped, and earlier messages (e.g., user) sort
      // before later ones (e.g., assistant response).
      const insertIdx = findSortedInsertIdx(s.conversation, msg.timestamp);
      s.conversation.splice(insertIdx, 0, row);

      // Shift existing tracked indices that are at or after the insert point
      if (s.activeTextIdx !== null && s.activeTextIdx >= insertIdx) s.activeTextIdx++;
      if (s.activeThinkingIdx !== null && s.activeThinkingIdx >= insertIdx) s.activeThinkingIdx++;
      rebuildToolCallIdxMap(s);

      // Record the index of the newly inserted text/thinking row as the active block
      if (msg.type === 'text') {
        s.activeTextIdx = insertIdx;
      } else if (msg.type === 'thinking') {
        s.activeThinkingIdx = insertIdx;
      }

      const tokens = extractContextTokens(msg);
      if (tokens !== null) s.contextTokens = tokens;

      if (msg.type === 'turn_end' && msg.usage?.contextWindow !== undefined) {
        s.contextWindow = msg.usage.contextWindow;
      }
    });
  }

  /**
   * Ingest a batch of messages (history load from JSONL).
   * Prepends any messages not already in conversation (history comes first).
   * Only runs once per card (guards with historyLoaded flag).
   */
  ingestBatch(cardId: number, messages: AgentMessage[]): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId);

      if (s.historyLoaded) return;

      const newRows: ConversationRow[] = [];

      for (const msg of messages) {
        const { timestamp, ...stable } = msg;
        const id = contentHashSync(msg.type, stable);
        newRows.push({ ...msg, id });
      }

      const isReload = s.conversation.length > 0;

      if (isReload) {
        // Reconnect reload: replace conversation in place with full server history.
        // This avoids the spinner flash from clearing and also picks up any
        // messages that arrived while disconnected.
        s.conversation.splice(0, s.conversation.length, ...newRows);
      } else {
        // Initial load: filter out any messages already delivered live
        // (race: live sub fires before history arrives), then prepend.
        const existingIds = new Set(s.conversation.map((r) => r.id));
        const deduped = newRows.filter((r) => !existingIds.has(r.id));
        if (deduped.length > 0) {
          s.conversation.unshift(...deduped);
        }
      }

      rebuildToolCallIdxMap(s);
      s.conversationIds = new Set(s.conversation.map((r) => r.id));

      // Scan backward through conversation to seed context state from most recent turn
      let foundTokens = false;
      let foundWindow = false;
      for (let i = s.conversation.length - 1; i >= 0; i--) {
        const row = s.conversation[i];
        if (!foundTokens) {
          const tokens = extractContextTokens(row);
          if (tokens !== null) {
            s.contextTokens = tokens;
            foundTokens = true;
          }
        }
        if (!foundWindow && row.type === 'turn_end' && row.usage?.contextWindow !== undefined) {
          s.contextWindow = row.usage.contextWindow;
          foundWindow = true;
        }
        if (foundTokens && foundWindow) break;
      }

      s.historyLoaded = true;
    });
  }

  /**
   * Clear conversation state (card switch, session reset).
   */
  clearConversation(cardId: number): void {
    const s = this.sessions.get(cardId);
    if (!s) return;
    s.conversation.splice(0);
    s.toolCallIdxMap.clear();
    s.historyLoaded = false;
    s.contextTokens = 0;
    s.contextWindow = 200_000;
    s.activeTextIdx = null;
    s.activeThinkingIdx = null;
    // Clear subagent state
    s.subagents.clear();
    for (const [key, timer] of this.subagentTimeouts) {
      if (key.startsWith(`${cardId}:`)) {
        clearTimeout(timer);
        this.subagentTimeouts.delete(key);
      }
    }
  }

  handleAgentStatus(data: AgentStatus) {
    runInAction(() => {
      const s = this.getOrCreate(data.cardId);
      s.active = data.active;
      s.status = data.status;
      s.sessionId = data.sessionId;
      s.promptsSent = data.promptsSent;
      s.turnsCompleted = data.turnsCompleted;
      // Always accept context data from server status (source of truth)
      if (data.contextTokens > 0) {
        s.contextTokens = data.contextTokens;
      }
      if (data.contextWindow > 0) {
        s.contextWindow = data.contextWindow;
      }
      // Clear subagent rows and stop retry interval when parent session ends
      if (data.status === 'completed' || data.status === 'stopped' || data.status === 'errored') {
        s.subagents.clear();
        for (const [key, timer] of this.subagentTimeouts) {
          if (key.startsWith(`${data.cardId}:`)) {
            clearTimeout(timer);
            this.subagentTimeouts.delete(key);
          }
        }
        const stopInterval = this.stopIntervals.get(data.cardId);
        if (stopInterval !== undefined) {
          clearInterval(stopInterval);
          this.stopIntervals.delete(data.cardId);
        }
        this.stoppingCards.delete(data.cardId);
      }
    });
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async sendMessage(cardId: number, message: string, files?: FileRef[]): Promise<void> {
    this.ingest(cardId, {
      type: 'user',
      role: 'user',
      content: message,
      meta: { optimistic: true, files },
      timestamp: Date.now(),
    });

    // Optimistically set status to running so Stop button appears immediately
    const s = this.getOrCreate(cardId);
    s.active = true;
    s.status = 'running';
    s.promptsSent = (s.promptsSent ?? 0) + 1;

    const requestId = uuid();
    try {
      await ws().mutate({
        type: 'agent:send',
        requestId,
        data: { cardId, message, files },
      });
    } catch (err) {
      // On timeout or disconnect, verify what actually happened instead of
      // assuming failure. The mutation may have succeeded (server sends
      // mutation:ok immediately) but the ack was lost (e.g., PWA suspend,
      // Vite restart, tunnel flap).
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Mutation timeout' || msg === 'WebSocket disconnected') {
        console.warn(`[session] agent:send ${msg} for card ${cardId}, verifying status…`);
        this.requestStatus(cardId).catch(() => {});
        return; // Don't propagate — let status check reconcile the UI
      }
      throw err; // Real errors (validation, etc.) still bubble up
    }
  }

  async compactSession(cardId: number): Promise<void> {
    const requestId = uuid();
    await ws().mutate({
      type: 'agent:compact',
      requestId,
      data: { cardId },
    });
  }

  stopSession(cardId: number): void {
    if (this.stoppingCards.has(cardId)) return;
    const s = this.sessions.get(cardId);
    if (s && (s.status === 'stopped' || s.status === 'completed' || s.status === 'errored')) return;

    runInAction(() => this.stoppingCards.add(cardId));

    const sendStop = () => ws().send({ type: 'agent:stop', requestId: uuid(), data: { cardId } });
    sendStop();
    this.stopIntervals.set(cardId, setInterval(sendStop, 1000));
  }

  async requestStatus(cardId: number): Promise<void> {
    const requestId = uuid();
    await ws().mutate({
      type: 'agent:status',
      requestId,
      data: { cardId },
    });
  }

  async loadHistory(cardId: number, sessionId?: string | null): Promise<void> {
    this.subscribedCards.add(cardId);
    const requestId = uuid();
    await ws().mutate({
      type: 'session:load',
      requestId,
      data: { cardId, ...(sessionId ? { sessionId } : {}) },
    });
    // History arrives via session:history server message, routed to ingestBatch()
    // If sessionId was null, bus subscriptions are still set up for live messages.
  }

  async resubscribeAll(): Promise<void> {
    for (const cardId of this.subscribedCards) {
      const s = this.sessions.get(cardId);

      // Reset historyLoaded so ingestBatch will accept the fresh history payload.
      // Keep existing conversation visible (no spinner) — ingestBatch will
      // replace it in place once the server sends the full history.
      if (s) {
        s.historyLoaded = false;
        s.activeTextIdx = null;
        s.activeThinkingIdx = null;
      }

      const sid = s?.sessionId;
      const requestId = uuid();
      ws()
        .mutate({
          type: 'session:load',
          requestId,
          data: { cardId, ...(sid ? { sessionId: sid } : {}) },
        })
        .catch((err) => console.warn('[ws] resubscribe failed for card', cardId, err));

      // Also request fresh status so the UI knows if the session is running/idle/errored
      this.requestStatus(cardId).catch((err) => console.warn('[ws] status request failed for card', cardId, err));
    }
  }
}
