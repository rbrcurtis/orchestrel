import { makeAutoObservable, observable, runInAction, autorun, type IReactionDisposer } from 'mobx';
import type { AgentStatus, FileRef } from '../../src/shared/ws-protocol';
import type { WsClient } from '../lib/ws-client';
import type { SdkMessage, HistoryMessage } from '../lib/sdk-types';
import { MessageAccumulator } from '../lib/message-accumulator';
import { readConversation, writeConversation } from '../lib/conversation-cache';

export interface SessionState {
  active: boolean;
  status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped';
  sessionId: string | null;
  promptsSent: number;
  turnsCompleted: number;
  accumulator: MessageAccumulator;
  historyLoaded: boolean;
  cacheHydrated: boolean;
  contextTokens: number;
  contextWindow: number;
  bgcInProgress: boolean;
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
    cacheHydrated: false,
    contextTokens: 0,
    contextWindow: 200_000,
    bgcInProgress: false,
  };
}

export class SessionStore {
  sessions = observable.map<number, SessionState>();
  subscribedCards = new Set<number>();
  stoppingCards = observable.set<number>();
  private stopIntervals = new Map<number, NodeJS.Timeout>();
  private loadingCards = new Set<number>();
  private persistDisposers = new Map<number, IReactionDisposer>();
  private _ws: WsClient | null = null;

  constructor() {
    makeAutoObservable<this, 'stopIntervals' | 'loadingCards' | 'persistDisposers' | '_ws'>(this, {
      stopIntervals: false,
      loadingCards: false,
      persistDisposers: false,
      _ws: false,
    });
  }

  setWs(ws: WsClient) { this._ws = ws; }
  private ws(): WsClient {
    if (!this._ws) throw new Error('WsClient not set');
    return this._ws;
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

  async hydrateFromCache(cardId: number): Promise<void> {
    const s = this.getOrCreate(cardId);
    if (s.historyLoaded || s.cacheHydrated) return;
    const entries = await readConversation(cardId);
    if (!entries || entries.length === 0) return;
    runInAction(() => {
      // loadHistory may have won the race while we awaited the cache read
      if (s.historyLoaded) return;
      s.accumulator.hydrate(entries);
      s.cacheHydrated = true;
    });
  }

  startPersisting(cardId: number): void {
    if (this.persistDisposers.has(cardId)) return;
    const s = this.getOrCreate(cardId);
    const dispose = autorun(
      () => {
        const entries = s.accumulator.serialize();
        if (entries.length === 0) return;
        writeConversation(cardId, entries).catch(() => {});
      },
      { delay: 1000 },
    );
    this.persistDisposers.set(cardId, dispose);
  }

  // Release a card's in-memory conversation when its view unmounts. The full
  // transcript lives in IndexedDB (writeConversation), so dropping it from RAM is
  // safe — hydrateFromCache repopulates it instantly on reopen. Without this the
  // sessions map grows unbounded as the user browses cards. Active (running)
  // sessions are never evicted: they keep accumulating streamed messages off-screen.
  async evictSession(cardId: number): Promise<void> {
    const s = this.sessions.get(cardId);
    if (!s) return;
    if (s.active) return;

    // Snapshot before dropping, then do all synchronous store mutations inside the
    // auto-action (before the first await) so MobX sees them as a single action.
    const entries = s.accumulator.serialize();
    const dispose = this.persistDisposers.get(cardId);
    if (dispose) {
      dispose();
      this.persistDisposers.delete(cardId);
    }
    this.sessions.delete(cardId);
    this.subscribedCards.delete(cardId);

    // Final flush so the latest state is in IndexedDB before the RAM copy is gone.
    if (entries.length > 0) await writeConversation(cardId, entries).catch(() => {});
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

      if (sdkMsg.type === 'system') {
        if (sdkMsg.subtype === 'bgc_started') {
          s.bgcInProgress = true;
        }
        if (sdkMsg.subtype === 'compact_boundary') {
          s.bgcInProgress = false;
          s.contextTokens = 1;
        }
      }

      if (sdkMsg.type === 'error') {
        s.active = false;
        s.status = 'errored';
        s.bgcInProgress = false;
      }

      if (sdkMsg.type === 'result') {
        s.bgcInProgress = false;
      }

      s.accumulator.handleMessage(sdkMsg);
    });
  }

  ingestHistory(cardId: number, messages: unknown[]): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId);
      s.accumulator.clear();
      for (const msg of messages) {
        s.accumulator.handleHistoryMessage(msg as HistoryMessage);
      }
      s.accumulator.flushHistory();
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
    let justEnded = false;
    runInAction(() => {
      const s = this.getOrCreate(data.cardId);
      const wasActive = s.active;
      s.active = data.active;
      s.status = data.status;
      s.sessionId = data.sessionId;
      s.promptsSent = data.promptsSent;
      s.turnsCompleted = data.turnsCompleted;
      s.contextTokens = data.contextTokens;
      if (data.contextWindow > 0) s.contextWindow = data.contextWindow;

      if (data.status === 'completed' || data.status === 'stopped' || data.status === 'errored') {
        s.bgcInProgress = false;
        s.accumulator.clearSubagents();
        const stopInterval = this.stopIntervals.get(data.cardId);
        if (stopInterval !== undefined) {
          clearInterval(stopInterval);
          this.stopIntervals.delete(data.cardId);
        }
        this.stoppingCards.delete(data.cardId);
        // Pi appends the final assistant message to the session .jsonl only as the
        // run resolves — the same moment orcd emits session_exit. A session:load
        // during the finishing window therefore reads a transcript missing that
        // last message (the agent's closing summary). Now that the session has
        // ended the file is flushed, so reload once on the active→terminal edge to
        // backfill it. Gated to open cards; idempotent for already-complete ones.
        if (wasActive && this.subscribedCards.has(data.cardId)) justEnded = true;
      }
    });
    if (justEnded) {
      this.loadHistory(data.cardId, data.sessionId).catch(() => {});
    }
  }

  handleSessionExit(cardId: number): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId);
      s.active = false;
      s.bgcInProgress = false;
      if (s.status === 'running' || s.status === 'starting') {
        s.status = 'completed';
      }
      s.accumulator.clearSubagents();
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

    try {
      await this.ws().emit('agent:send', { cardId, message, files });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[session] agent:send error for card ${cardId}: ${msg}, verifying status…`);
      this.requestStatus(cardId).catch(() => {});
    }
  }

  async compactSession(cardId: number): Promise<void> {
    const s = this.getOrCreate(cardId);
    if (s.bgcInProgress) {
      s.accumulator.addCompactMarker('Background compaction already in progress');
      return;
    }
    await this.ws().emit('agent:compact', { cardId });
  }

  stopSession(cardId: number): void {
    if (this.stoppingCards.has(cardId)) return;
    const s = this.sessions.get(cardId);
    if (s && (s.status === 'stopped' || s.status === 'completed' || s.status === 'errored')) return;

    runInAction(() => this.stoppingCards.add(cardId));

    const sendStop = () => {
      this.ws().socket.emit('agent:stop', { cardId }, () => {});
    };
    sendStop();
    this.stopIntervals.set(cardId, setInterval(sendStop, 1000));
  }

  async requestStatus(cardId: number): Promise<void> {
    // requestStatus fires on every SessionView mount, including when history is
    // served from cache and loadHistory short-circuits. Mark the card subscribed
    // here so the "viewed card ⇒ subscribed" invariant holds regardless of the
    // cache path — otherwise resubscribeAll() skips it after a reconnect and the
    // socket silently stops receiving this card's live events.
    this.subscribedCards.add(cardId);
    await this.ws().emit('agent:status', { cardId });
  }

  async loadHistory(cardId: number, sessionId?: string | null): Promise<void> {
    if (this.loadingCards.has(cardId)) return;
    this.loadingCards.add(cardId);
    this.subscribedCards.add(cardId);
    try {
      const result = (await this.ws().emit('session:load', {
        cardId,
        ...(sessionId ? { sessionId } : {}),
      })) as { messages: unknown[] } | undefined;

      if (result?.messages) {
        this.ingestHistory(cardId, result.messages);
      }
    } finally {
      this.loadingCards.delete(cardId);
    }
  }

  async resubscribeAll(): Promise<void> {
    for (const cardId of this.subscribedCards) {
      const s = this.sessions.get(cardId);
      if (s) s.historyLoaded = false;

      const sid = s?.sessionId;
      this.loadHistory(cardId, sid).catch((err) =>
        console.warn('[ws] resubscribe failed for card', cardId, err),
      );

      this.requestStatus(cardId).catch((err) =>
        console.warn('[ws] status request failed for card', cardId, err),
      );
    }
  }
}
