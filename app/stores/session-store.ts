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
    conversation: [],
    toolCallIdxMap: new Map(),
    historyLoaded: false,
    contextTokens: 0,
    contextWindow: 200_000,
    subagents: observable.map(),
  };
}

export class SessionStore {
  sessions = observable.map<number, SessionState>();
  subscribedCards = new Set<number>();
  private subagentTimeouts = new Map<string, NodeJS.Timeout>();

  constructor() {
    makeAutoObservable(this, { subagentTimeouts: false });
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

      if (msg.type === 'subagent' && msg.meta) {
        const m = msg.meta as { subtype: string; childSessionId: string; title: string; tool?: string; target?: string };
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
          this.subagentTimeouts.set(timeoutKey, setTimeout(() => {
            runInAction(() => {
              s.subagents.delete(m.childSessionId);
            });
            this.subagentTimeouts.delete(timeoutKey);
          }, 2000));
        }
        return; // Don't add subagent messages to conversation
      }

      const { timestamp, ...stable } = msg;
      const id = contentHashSync(msg.type, stable);

      // Server echo for a user message — confirm the optimistic row
      if (msg.type === 'user' && !msg.meta?.optimistic) {
        const idx = s.conversation.findLastIndex(
          (r) => r.type === 'user' && r.optimistic && r.content === msg.content,
        );
        if (idx !== -1) {
          s.conversation[idx].optimistic = false;
          return;
        }
      }

      if (msg.type === 'tool_call' && msg.toolCall?.id) {
        const existingIdx = s.toolCallIdxMap.get(msg.toolCall.id);
        if (existingIdx !== undefined) {
          const existing = s.conversation[existingIdx];
          const existingParamCount = Object.keys(existing.toolCall?.params ?? {}).length;
          const newParamCount = Object.keys(msg.toolCall.params ?? {}).length;
          if (newParamCount > existingParamCount) {
            s.conversation.splice(existingIdx, 1, { ...msg, id });
          }
          return; // Either replaced or kept existing — never append a duplicate
        }
        // New tool_call: register its future index for in-place updates
        s.toolCallIdxMap.set(msg.toolCall.id, s.conversation.length);
      }

      const row: ConversationRow = { ...msg, id };
      if (msg.meta?.optimistic) row.optimistic = true;
      s.conversation.push(row);

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

      if (newRows.length > 0) {
        // Prepend history before any live messages
        s.conversation.unshift(...newRows);
      }

      // Rebuild toolCallIdxMap from scratch after prepend (indices shifted)
      s.toolCallIdxMap.clear();
      for (let i = 0; i < s.conversation.length; i++) {
        const row = s.conversation[i];
        if (row.type === 'tool_call' && row.toolCall?.id) {
          s.toolCallIdxMap.set(row.toolCall.id, i);
        }
      }

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
      // Clear subagent rows when parent session ends
      if (data.status === 'completed' || data.status === 'stopped' || data.status === 'errored') {
        s.subagents.clear();
        for (const [key, timer] of this.subagentTimeouts) {
          if (key.startsWith(`${data.cardId}:`)) {
            clearTimeout(timer);
            this.subagentTimeouts.delete(key);
          }
        }
      }
    });
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async sendMessage(cardId: number, message: string, files?: FileRef[]): Promise<void> {
    // Only add optimistic message when no files (file prompts get augmented server-side)
    if (!files?.length) {
      this.ingest(cardId, {
        type: 'user',
        role: 'user',
        content: message,
        meta: { optimistic: true },
        timestamp: Date.now(),
      });
    }

    // Optimistically set status to running so Stop button appears immediately
    const s = this.getOrCreate(cardId);
    s.active = true;
    s.status = 'running';
    s.promptsSent = (s.promptsSent ?? 0) + 1;

    const requestId = uuid();
    await ws().mutate({
      type: 'agent:send',
      requestId,
      data: { cardId, message, files },
    });
  }

  async stopSession(cardId: number): Promise<void> {
    const requestId = uuid();
    await ws().mutate({
      type: 'agent:stop',
      requestId,
      data: { cardId },
    });
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
      const requestId = uuid();
      ws().mutate({
        type: 'session:load',
        requestId,
        data: { cardId },
      }).catch((err) => console.warn('[ws] resubscribe failed for card', cardId, err));
    }
  }
}
