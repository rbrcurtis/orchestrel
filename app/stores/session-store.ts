import { makeAutoObservable, observable, runInAction } from 'mobx';
import type { AgentStatus, FileRef } from '../../src/shared/ws-protocol';
import type { WsClient } from '../lib/ws-client';
import type { SdkMessage, HistoryMessage } from '../lib/sdk-types';
import { MessageAccumulator } from '../lib/message-accumulator';
import { uuid } from '../lib/utils';

let _ws: WsClient | null = null;

export function setSessionStoreWs(ws: WsClient) {
  _ws = ws;
}

function ws(): WsClient {
  if (!_ws) throw new Error('WsClient not set');
  return _ws;
}

export interface SessionState {
  active: boolean;
  status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped' | 'retry';
  sessionId: string | null;
  promptsSent: number;
  turnsCompleted: number;
  accumulator: MessageAccumulator;
  historyLoaded: boolean;
  contextTokens: number;
  contextWindow: number;
}

function defaultSession(): SessionState {
  return {
    active: false,
    status: 'stopped',
    sessionId: null,
    promptsSent: 0,
    turnsCompleted: 0,
    accumulator: new MessageAccumulator(),
    historyLoaded: false,
    contextTokens: 0,
    contextWindow: 200_000,
  };
}

export class SessionStore {
  sessions = observable.map<number, SessionState>();
  subscribedCards = new Set<number>();
  stoppingCards = observable.set<number>();
  private stopIntervals = new Map<number, NodeJS.Timeout>();

  constructor() {
    makeAutoObservable<this, 'stopIntervals'>(this, {
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

  ingestSdkMessage(cardId: number, msg: unknown): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId);
      const sdkMsg = msg as SdkMessage;

      // If content arrives for a session we think is inactive, flip it back
      if (!s.active && (sdkMsg.type === 'stream_event' || sdkMsg.type === 'assistant')) {
        s.active = true;
        s.status = 'running';
      }

      s.accumulator.handleMessage(sdkMsg);

      // Extract context info from result messages
      if (sdkMsg.type === 'result') {
        const r = sdkMsg as { usage?: {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          iterations?: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }[];
        } };
        if (r.usage) {
          // Top-level usage is cumulative across all iterations in the turn.
          // Use the last iteration to get the actual current context window state.
          const last = r.usage.iterations?.at(-1);
          const u = last ?? r.usage;
          s.contextTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        }
      }
    });
  }

  ingestHistory(cardId: number, messages: unknown[]): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId);
      s.accumulator.clear();
      for (const msg of messages) {
        s.accumulator.handleHistoryMessage(msg as HistoryMessage);
      }
      s.historyLoaded = true;
    });
  }

  clearConversation(cardId: number): void {
    const s = this.sessions.get(cardId);
    if (!s) return;
    s.accumulator.clear();
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
      if (data.contextTokens > 0) s.contextTokens = data.contextTokens;
      if (data.contextWindow > 0) s.contextWindow = data.contextWindow;

      if (data.status === 'completed' || data.status === 'stopped' || data.status === 'errored') {
        const stopInterval = this.stopIntervals.get(data.cardId);
        if (stopInterval !== undefined) {
          clearInterval(stopInterval);
          this.stopIntervals.delete(data.cardId);
        }
        this.stoppingCards.delete(data.cardId);
      }
    });
  }

  handleSessionExit(cardId: number): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId);
      s.active = false;
      if (s.status === 'running' || s.status === 'starting') {
        s.status = 'completed';
      }
      const stopInterval = this.stopIntervals.get(cardId);
      if (stopInterval !== undefined) {
        clearInterval(stopInterval);
        this.stopIntervals.delete(cardId);
      }
      this.stoppingCards.delete(cardId);
    });
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async sendMessage(cardId: number, message: string, files?: FileRef[]): Promise<void> {
    const s = this.getOrCreate(cardId);

    // Add optimistic user message
    s.accumulator.addUserMessage(message, true);

    // Optimistically set status to running
    runInAction(() => {
      s.active = true;
      s.status = 'running';
      s.promptsSent = (s.promptsSent ?? 0) + 1;
    });

    const requestId = uuid();
    try {
      await ws().mutate({
        type: 'agent:send',
        requestId,
        data: { cardId, message, files },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Mutation timeout' || msg === 'WebSocket disconnected') {
        console.warn(`[session] agent:send ${msg} for card ${cardId}, verifying status…`);
        this.requestStatus(cardId).catch(() => {});
        return;
      }
      throw err;
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
  }

  async resubscribeAll(): Promise<void> {
    for (const cardId of this.subscribedCards) {
      const s = this.sessions.get(cardId);
      if (s) s.historyLoaded = false;

      const sid = s?.sessionId;
      const requestId = uuid();
      ws()
        .mutate({
          type: 'session:load',
          requestId,
          data: { cardId, ...(sid ? { sessionId: sid } : {}) },
        })
        .catch((err) => console.warn('[ws] resubscribe failed for card', cardId, err));

      this.requestStatus(cardId).catch((err) => console.warn('[ws] status request failed for card', cardId, err));
    }
  }
}
