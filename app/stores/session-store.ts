import { makeAutoObservable, observable, runInAction } from 'mobx';
import type { AgentStatus, FileRef } from '../../src/shared/ws-protocol';
import { parseAppCommands } from '../../src/shared/slash-commands';
import type { WsClient } from '../lib/ws-client';
import type { SdkMessage, HistoryMessage } from '../lib/sdk-types';
import { TranscriptReplica } from '../../src/shared/transcript-reducer';
import type { TranscriptEnvelope, TranscriptEvent } from '../../src/shared/transcript-sync';
import { renderTranscriptSnapshot } from '../lib/transcript-display';
import { MessageAccumulator } from '../lib/message-accumulator';
import { readTranscriptPage, writeTranscriptPage, type TranscriptCacheScope } from '../lib/transcript-cache';
import type { TranscriptHistoryPage } from '../../src/shared/transcript-history';

export interface SessionState {
  active: boolean;
  status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped';
  sessionId: string | null;
  promptsSent: number;
  turnsCompleted: number;
  accumulator: MessageAccumulator;
  historyLoaded: boolean;
  contextTokens: number;
  contextWindow: number;
  bgcInProgress: boolean;
  compactInProgress: boolean;
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
    bgcInProgress: false,
    compactInProgress: false,
  };
}

export class SessionStore {
  sessions = observable.map<number, SessionState>();
  subscribedCards = new Set<number>();
  stoppingCards = observable.set<number>();
  private stopIntervals = new Map<number, NodeJS.Timeout>();
  private loadingCards = new Set<number>();
  private _ws: WsClient | null = null;
  private cacheScopes = new Map<number, TranscriptCacheScope>();
  private historyPages = new Map<number, TranscriptHistoryPage>();
  private historyMessages = new Map<number, unknown[]>();
  private messageVersions = new Map<number, number>();
  private replicas = new Map<number, TranscriptReplica>();
  private liveLoading = new Map<number, TranscriptEnvelope<TranscriptEvent>[]>();
  private liveFrames = new Set<number>();

  private paintLive(cardId: number): void {
    if (this.liveFrames.has(cardId)) return;
    this.liveFrames.add(cardId);
    setTimeout(
      () =>
        runInAction(() => {
          this.liveFrames.delete(cardId);
          const replica = this.replicas.get(cardId);
          const session = this.sessions.get(cardId);
          if (!replica || !session) return;
          replica.trimVisible();
          renderTranscriptSnapshot(session.accumulator, replica.snapshot().state);
          session.historyLoaded = true;
        }),
      100,
    );
  }

  private async loadLive(cardId: number): Promise<void> {
    if (this.liveLoading.has(cardId)) return;
    const pending: TranscriptEnvelope<TranscriptEvent>[] = [];
    this.liveLoading.set(cardId, pending);
    const scope = this.cacheScopes.get(cardId);
    try {
      const snapshot = (await this.ws().emit('session:transcript', {
        cardId,
      })) as import('../../src/shared/orcd-protocol').TranscriptSnapshotMessage['snapshot'];
      if (!snapshot || this.cacheScopes.get(cardId) !== scope) return;
      const replica = new TranscriptReplica();
      replica.applySnapshot(snapshot.cursor, snapshot.state);
      for (const envelope of pending) {
        if (replica.accept(envelope).type === 'snapshot_required')
          throw new Error('Live transcript changed during snapshot');
      }
      this.replicas.set(cardId, replica);
      this.paintLive(cardId);
    } catch (err) {
      console.warn('[transcript] live snapshot failed', err);
    } finally {
      this.liveLoading.delete(cardId);
    }
  }

  private pendingLoads = new Map<number, string | null | undefined>();

  setCacheScope(cardId: number, scope: TranscriptCacheScope): void {
    const previous = this.cacheScopes.get(cardId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(scope)) {
      this.replicas.delete(cardId);
      this.sessions.delete(cardId);
      this.historyPages.delete(cardId);
      this.historyMessages.delete(cardId);
      this.messageVersions.set(cardId, (this.messageVersions.get(cardId) ?? 0) + 1);
    }
    if (!previous || JSON.stringify(previous) !== JSON.stringify(scope)) {
      this.cacheScopes.set(cardId, scope);
      const session = this.sessions.get(cardId);
      if (session && !session.active) session.historyLoaded = false;
    }
  }

  clearCacheIdentity(): void {
    this.replicas.clear();
    this.cacheScopes.clear();
    this.historyPages.clear();
    this.historyMessages.clear();
    this.sessions.clear();
    this.subscribedCards.clear();
    for (const [id, version] of this.messageVersions) this.messageVersions.set(id, version + 1);
  }

  hasNewerHistory(cardId: number): boolean {
    return this.historyPages.get(cardId)?.hasNewer ?? false;
  }

  async loadNewerHistory(cardId: number): Promise<void> {
    await this.loadHistoryRange(cardId, 'newer');
  }

  hasOlderHistory(cardId: number): boolean {
    return this.historyPages.get(cardId)?.hasOlder ?? false;
  }

  async loadOlderHistory(cardId: number): Promise<void> {
    await this.loadHistoryRange(cardId, 'older');
  }

  private async loadHistoryRange(cardId: number, direction: 'older' | 'newer'): Promise<void> {
    const page = this.historyPages.get(cardId);
    const session = this.sessions.get(cardId);
    if (!page?.before || !session || session.active || this.loadingCards.has(cardId)) {
      console.debug('[transcript] older page unavailable', cardId);
      return;
    }
    this.loadingCards.add(cardId);
    const version = this.messageVersions.get(cardId) ?? 0;
    try {
      const scope = this.cacheScopes.get(cardId);
      const anchor = `${page.revision}:${direction}:${direction === 'older' ? page.before : page.after}`;
      const cached = scope ? await readTranscriptPage(scope, anchor) : undefined;
      const saved = cached?.records[0] as TranscriptHistoryPage | undefined;
      const result =
        saved?.revision === page.revision
          ? saved
          : ((await this.ws().emit('session:history-page', {
              cardId,
              page:
                direction === 'older'
                  ? { before: page.before, revision: page.revision }
                  : { after: page.after ?? undefined, prefix: page.prefix, revision: page.revision, anchorOnly: true },
            })) as TranscriptHistoryPage | undefined);
      if (!result || result.reset || version !== (this.messageVersions.get(cardId) ?? 0)) {
        console.debug('[transcript] discarded stale older page', cardId);
        return;
      }
      const pageMessages = result.records.map((record) => record.message);
      if (direction === 'older') {
        // Prepending older pages lets scroll-up accumulate history instead of
        // replacing the view. Keep the newest anchor so the window still ends
        // at the record the reader already had.
        const merged = [...pageMessages, ...(this.historyMessages.get(cardId) ?? [])];
        runInAction(() =>
          this.historyPages.set(cardId, {
            ...result,
            after: page.after,
            prefix: page.prefix,
            hasNewer: page.hasNewer,
          }),
        );
        this.ingestHistory(cardId, merged);
      } else {
        // Appending newer pages keeps the already-loaded older rows.
        const merged = [...(this.historyMessages.get(cardId) ?? []), ...pageMessages];
        runInAction(() =>
          this.historyPages.set(cardId, {
            ...result,
            before: page.before,
            hasOlder: page.hasOlder,
          }),
        );
        this.ingestHistory(cardId, merged);
      }
      if (scope && !cached)
        await writeTranscriptPage(scope, { anchor, revision: result.revision, records: [result] }, null);
    } finally {
      this.loadingCards.delete(cardId);
    }
  }

  constructor() {
    makeAutoObservable<this, 'stopIntervals' | 'loadingCards' | '_ws'>(this, {
      stopIntervals: false,
      loadingCards: false,
      _ws: false,
    });
  }

  setWs(ws: WsClient) {
    this._ws = ws;
  }
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

  // Release an inactive card's conversation when its view unmounts. Reopening the
  // card reloads authoritative history from the server. Active off-screen sessions
  // remain subscribed so their streamed messages are not lost.
  evictSession(cardId: number): void {
    const s = this.sessions.get(cardId);
    if (!s || s.active) return;
    this.sessions.delete(cardId);
    this.historyPages.delete(cardId);
    this.historyMessages.delete(cardId);
    this.replicas.delete(cardId);
    this.subscribedCards.delete(cardId);
  }

  // ── Incoming server messages ────────────────────────────────────────────────

  ingestSdkMessage(cardId: number, msg: unknown): void {
    this.messageVersions.set(cardId, (this.messageVersions.get(cardId) ?? 0) + 1);
    runInAction(() => {
      const s = this.getOrCreate(cardId);
      const sdkMsg = msg as SdkMessage;
      if (
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'transcript_event' &&
        'envelope' in msg
      ) {
        const envelope = msg.envelope as TranscriptEnvelope<TranscriptEvent>;
        const pending = this.liveLoading.get(cardId);
        if (pending) {
          if (pending.length < 2048) pending.push(envelope);
          else pending.splice(0, pending.length, envelope);
          return;
        }
        const replica = this.replicas.get(cardId);
        if (!replica || replica.accept(envelope).type === 'snapshot_required') void this.loadLive(cardId);
        else this.paintLive(cardId);
        return;
      }
      if (this.replicas.has(cardId) && ['stream_event', 'assistant', 'user', 'result'].includes(sdkMsg.type)) return;

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
        // A manual `/compact` runs no normal turn, so it emits no result/session_exit
        // to clear the optimistic "running" state. compact_done is its terminal
        // signal: reset context and return the session to idle.
        if (sdkMsg.subtype === 'compact_started') {
          s.compactInProgress = true;
        }
        if (sdkMsg.subtype === 'compact_done') {
          s.compactInProgress = false;
          s.contextTokens = 1;
          s.active = false;
          if (s.status === 'running' || s.status === 'starting') s.status = 'completed';
        }
      }

      if (sdkMsg.type === 'error') {
        s.active = false;
        s.status = 'errored';
        s.bgcInProgress = false;
        s.compactInProgress = false;
      }

      if (sdkMsg.type === 'result') {
        s.bgcInProgress = false;
      }

      s.accumulator.handleMessage(sdkMsg);
    });
  }

  ingestHistory(cardId: number, messages: unknown[]): void {
    this.historyMessages.set(cardId, messages);
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
    this.historyMessages.delete(cardId);
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
        s.compactInProgress = false;
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
      s.compactInProgress = false;
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

    // App slash commands (/done, /archive, /ready, /sleep, /delete) are
    // addressed to Orchestrel, not the model — the backend strips them and
    // applies the card action after sending. Echo only what the model will
    // receive so the bubble matches the transcript history. A command-only
    // message prompts nothing, so skip the echo and the optimistic running
    // flip; the card move arrives via the card:updated event. /delete is
    // terminal and /sleep parks the card, so neither prompts: surrounding text
    // is discarded with the command and nothing is echoed.
    const { text, action } = parseAppCommands(message);
    const hasPrompt = action !== 'delete' && action !== 'sleep' && (text.trim().length > 0 || (files?.length ?? 0) > 0);

    if (hasPrompt) {
      this.messageVersions.set(cardId, (this.messageVersions.get(cardId) ?? 0) + 1);
      s.accumulator.addUserMessage(text, true);

      // Optimistically set status to running
      runInAction(() => {
        s.active = true;
        s.status = 'running';
        s.promptsSent = (s.promptsSent ?? 0) + 1;
      });
    }

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
    if (this.loadingCards.has(cardId)) {
      this.pendingLoads.set(cardId, sessionId);
      return;
    }
    this.loadingCards.add(cardId);
    this.subscribedCards.add(cardId);
    try {
      const scope = this.cacheScopes.get(cardId);
      const version = this.messageVersions.get(cardId) ?? 0;
      if (this.replicas.has(cardId)) {
        await this.loadLive(cardId);
        return;
      }
      if (scope && sessionId && !this.sessions.get(cardId)?.active) {
        const cached = await readTranscriptPage(scope, 'latest');
        const unchanged = () =>
          version === (this.messageVersions.get(cardId) ?? 0) &&
          !this.sessions.get(cardId)?.active &&
          this.cacheScopes.get(cardId) === scope;
        const saved = cached?.records[0] as TranscriptHistoryPage | undefined;
        const valid = saved?.sessionId === sessionId && Array.isArray(saved.records) ? saved : undefined;
        if (valid && unchanged())
          this.ingestHistory(
            cardId,
            valid.records.map((record) => record.message),
          );
        let page = (await this.ws()
          .emit('session:history-page', {
            cardId,
            page: valid?.after
              ? {
                  after: valid.after,
                  prefix: valid.prefix,
                  revision: valid.revision,
                }
              : {},
          })
          .catch((err: unknown) => {
            console.warn('[transcript] page load failed; retaining existing display', err);
            return undefined;
          })) as TranscriptHistoryPage | undefined;
        if (page && valid && !page.reset) {
          const records = [...valid.records, ...page.records].slice(-120);
          page = {
            ...page,
            records,
            before: records[0]?.id ?? null,
            after: records.at(-1)?.id ?? null,
            hasOlder: valid.hasOlder || valid.records.length + page.records.length > 120,
          };
        }
        if (page?.hasNewer && unchanged()) {
          page = (await this.ws().emit('session:history-page', { cardId, page: {} })) as
            TranscriptHistoryPage | undefined;
        }
        if (page && page.sessionId === sessionId && unchanged()) {
          const confirmed = page;
          runInAction(() => this.historyPages.set(cardId, confirmed));
          this.ingestHistory(
            cardId,
            page.records.map((record) => record.message),
          );
          if (!valid || cached?.revision !== page.revision) {
            await writeTranscriptPage(
              scope,
              {
                anchor: 'latest',
                revision: page.revision,
                records: [page],
              },
              cached?.revision ?? null,
            );
          }
          return;
        }
      }
      const result = (await this.ws().emit('session:load', {
        cardId,
        ...(sessionId ? { sessionId } : {}),
      })) as { messages: unknown[] } | undefined;

      if (result?.messages && version === (this.messageVersions.get(cardId) ?? 0)) {
        this.ingestHistory(cardId, result.messages);
      }
    } finally {
      this.loadingCards.delete(cardId);
      if (this.pendingLoads.has(cardId)) {
        const pending = this.pendingLoads.get(cardId);
        this.pendingLoads.delete(cardId);
        void this.loadHistory(cardId, pending).catch((err) => console.warn('[transcript] follow-up load failed', err));
      }
    }
  }

  async resubscribeAll(): Promise<void> {
    for (const cardId of this.subscribedCards) {
      const s = this.sessions.get(cardId);
      if (s) s.historyLoaded = false;

      const sid = s?.sessionId;
      this.loadHistory(cardId, sid).catch((err) => console.warn('[ws] resubscribe failed for card', cardId, err));

      this.requestStatus(cardId).catch((err) => console.warn('[ws] status request failed for card', cardId, err));
    }
  }
}
