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
}

export interface SessionState {
  active: boolean;
  status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped';
  sessionId: string | null;
  promptsSent: number;
  turnsCompleted: number;
  conversation: ConversationRow[];
  conversationIds: Set<string>; // O(1) dedup lookup
  toolCallIdxMap: Map<string, number>; // toolCall.id → conversation index for in-place update
  historyLoaded: boolean; // true after first history load
  contextTokens: number;
  contextWindow: number;
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
    conversationIds: new Set(),
    toolCallIdxMap: new Map(),
    historyLoaded: false,
    contextTokens: 0,
    contextWindow: 200_000,
  };
}

export class SessionStore {
  sessions = observable.map<number, SessionState>();

  constructor() {
    makeAutoObservable(this);
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
      const { timestamp, ...stable } = msg;
      const id = contentHashSync(msg.type, stable);

      if (msg.type === 'tool_call' && msg.toolCall?.id) {
        const existingIdx = s.toolCallIdxMap.get(msg.toolCall.id);
        if (existingIdx !== undefined) {
          const existing = s.conversation[existingIdx];
          const existingParamCount = Object.keys(existing.toolCall?.params ?? {}).length;
          const newParamCount = Object.keys(msg.toolCall.params ?? {}).length;
          if (newParamCount > existingParamCount) {
            // Replace in-place with the richer (complete) version
            s.conversationIds.delete(existing.id);
            s.conversation.splice(existingIdx, 1, { ...msg, id });
            s.conversationIds.add(id);
          }
          return; // Either replaced or kept existing — never append a duplicate
        }
        // New tool_call: register its future index for in-place updates
        s.toolCallIdxMap.set(msg.toolCall.id, s.conversation.length);
      }

      if (s.conversationIds.has(id)) return; // dedup

      s.conversation.push({ ...msg, id });
      s.conversationIds.add(id);

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
        if (s.conversationIds.has(id)) continue;

        newRows.push({ ...msg, id });
        s.conversationIds.add(id);
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
    s.conversationIds.clear();
    s.toolCallIdxMap.clear();
    s.historyLoaded = false;
    s.contextTokens = 0;
    s.contextWindow = 200_000;
  }

  handleAgentStatus(data: AgentStatus) {
    runInAction(() => {
      const s = this.getOrCreate(data.cardId);
      s.active = data.active;
      s.status = data.status;
      s.sessionId = data.sessionId;
      s.promptsSent = data.promptsSent;
      s.turnsCompleted = data.turnsCompleted;
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
        timestamp: Date.now(),
      });
    }

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

  async loadHistory(cardId: number, sessionId: string): Promise<void> {
    const requestId = uuid();
    await ws().mutate({
      type: 'session:load',
      requestId,
      data: { cardId, sessionId },
    });
    // History arrives via session:history server message, routed to ingestBatch()
  }
}
