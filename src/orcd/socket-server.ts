import { createServer, type Server, type Socket } from 'net';
import type { CapabilitiesMessage, OrcdAction, OrcdMessage } from '../shared/orcd-protocol';
import { isCompactCommand } from '../shared/slash-commands';
import type { ProviderConfig } from './config';
import { fileStager } from './file-staging';

export interface OrcdListenConfig {
  listen: { host: string; port: number };
  authToken: string;
  name: string;
  ringBufferSize?: number;
}
import { OrcdSession, type SessionEventCallback } from './session';
import { SessionStore } from './session-store';

interface ClientState {
  socket: Socket;
  subscriptions: Map<string, SessionEventCallback>;
  authenticated: boolean;
}

export class OrcdServer {
  private server: Server | null = null;
  private clients = new Set<ClientState>();
  readonly store = new SessionStore();
  private compacting = new Set<string>(); // session IDs currently compacting
  private pendingApply = new Map<string, import('@earendil-works/pi-coding-agent').CompactionResult>();

  constructor(
    private opts: OrcdListenConfig,
    private providers: Record<string, ProviderConfig>,
    private defaults: { provider: string; model: string; thinkingLevel?: string },
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.opts.listen.port, this.opts.listen.host, () => {
        console.log(`[orcd] listening on ${this.opts.listen.host}:${this.opts.listen.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.socket.destroy();
    await Promise.all(this.store.values().map(async (session) => {
      await session.dispose().catch((err: unknown) => {
        console.error(`[orcd] failed to dispose session ${session.id.slice(0, 8)}:`, err);
      });
      this.store.remove(session.id);
    }));
    await new Promise<void>((resolve) => {
      if (!this.server) {
        console.log('[orcd] listener already stopped');
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = null;
    console.log('[orcd] stopped');
  }

  private handleConnection(socket: Socket): void {
    const client: ClientState = { socket, subscriptions: new Map(), authenticated: false };
    this.clients.add(client);
    console.log('[orcd] client connected');

    let buf = '';
    socket.on('data', (data) => {
      buf += data.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const action = JSON.parse(line) as OrcdAction;
          this.handleAction(client, action);
        } catch (err) {
          console.error(`[orcd] parse error on action line:`, err);
          this.send(client, { type: 'error', sessionId: '', error: `parse error: ${err}` });
        }
      }
    });

    socket.on('close', () => {
      for (const [sessionId, cb] of client.subscriptions) {
        this.store.get(sessionId)?.unsubscribe(cb);
      }
      this.clients.delete(client);
      console.log('[orcd] client disconnected');
    });

    socket.on('error', (err) => {
      console.error('[orcd] client error:', err.message);
    });
  }

  private send(client: ClientState, msg: OrcdMessage): void {
    if (client.socket.writable) {
      client.socket.write(JSON.stringify(msg) + '\n');
    }
  }

  private handleAction(client: ClientState, action: OrcdAction): void {
    if (action.action === 'hello') {
      console.log('[orcd] hello received');
      this.handleHello(client, action);
      return;
    }
    if (!client.authenticated) {
      console.warn('[orcd] dropping action before hello:', action.action);
      return;
    }
    switch (action.action) {
      case 'create':
        this.handleCreate(client, action);
        break;
      case 'message':
        this.handleMessage(client, action);
        break;
      case 'warm':
        this.handleWarm(client, action);
        break;
      case 'set_effort':
        this.handleSetEffort(action);
        break;
      case 'set_summarize_threshold':
        this.handleSetSummarizeThreshold(action);
        break;
      case 'set_model':
        this.handleSetModel(action);
        break;
      case 'subscribe':
        this.handleSubscribe(client, action);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(client, action);
        break;
      case 'list':
        this.send(client, { type: 'session_list', sessions: this.store.list() });
        break;
      case 'cancel':
        this.handleCancel(action);
        break;
      case 'close':
        this.handleClose(action);
        break;
      case 'compact':
        this.handleCompact(client, action);
        break;
      case 'capabilities':
        this.send(client, this.buildCapabilities(action.requestId));
        break;
      case 'worktree_prepare':
        this.handleWorktreePrepare(client, action);
        break;
      case 'worktree_remove':
        this.handleWorktreeRemove(client, action);
        break;
      case 'path_validate':
        this.handlePathValidate(client, action);
        break;
      case 'get_history':
        this.handleGetHistory(client, action);
        break;
      case 'file_stage':
        this.handleFileStage(client, action);
        break;
    }
  }

  private handleFileStage(client: ClientState, action: OrcdAction & { action: 'file_stage' }): void {
    try {
      const file = fileStager.stage(action);
      this.send(client, { type: 'file_staged', requestId: action.requestId, file });
    } catch (err) {
      console.error('[orcd] file_stage failed:', err instanceof Error ? err.message : String(err));
      this.send(client, {
        type: 'error',
        sessionId: '',
        requestId: action.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private buildCapabilities(requestId?: string): CapabilitiesMessage {
    const providers = Object.entries(this.providers).map(([id, cfg]) => ({
      id,
      label: cfg.label ?? id,
      models: Object.entries(cfg.modelLabels ?? {}).map(([, m]) => ({
        alias: m.alias, label: m.label, contextWindow: m.contextWindow,
      })),
    }));
    return { type: 'capabilities', requestId, name: this.opts.name, providers, defaults: this.defaults };
  }

  private handleHello(client: ClientState, action: OrcdAction & { action: 'hello' }): void {
    if (action.token !== this.opts.authToken) {
      console.warn('[orcd] hello: invalid token, closing connection');
      this.send(client, { type: 'error', sessionId: '', error: 'invalid token', requestId: action.requestId });
      client.socket.destroy();
      return;
    }
    client.authenticated = true;
    this.send(client, this.buildCapabilities(action.requestId));
  }

  private handleCreate(client: ClientState, action: OrcdAction & { action: 'create' }): void {
    const existing = action.sessionId ? this.store.get(action.sessionId) : undefined;
    if (existing) {
      if (!client.subscriptions.has(existing.id)) {
        const cb: SessionEventCallback = (msg) => this.send(client, msg);
        client.subscriptions.set(existing.id, cb);
        existing.subscribe(cb);
      }
      this.send(client, { type: 'session_created', sessionId: existing.id });
      const runPrompt = () =>
        existing.sendMessage(action.prompt, action.effort).finally(() => {
          console.log(`[orcd] session ${existing.id.slice(0, 8)} follow-up exited (state=${existing.state})`);
        });
      // Self-heal a stale runtime: a card's provider/model may have changed
      // while this session stayed resident (the UI can't hot-swap it alone).
      // Switch before prompting so the turn runs the newly selected model;
      // if the switch is unsupported, log and continue on the old model.
      if (existing.model !== action.model || existing.provider !== action.provider) {
        const cfg = this.providers[action.provider];
        if (cfg) {
          existing
            .setModel(action.provider, action.model, cfg)
            .then(runPrompt)
            .catch((err: unknown) => {
              console.error(`[orcd:${existing.id.slice(0, 8)}] set_model on resume failed:`, err instanceof Error ? err.message : String(err));
              runPrompt();
            });
          console.log(`[orcd:${existing.id.slice(0, 8)}] reusing resident session with model switch`);
          return;
        }
        console.error(`[orcd:${existing.id.slice(0, 8)}] set_model on resume: unknown provider ${action.provider}`);
      }
      runPrompt();
      console.log(`[orcd] reusing resident session ${existing.id.slice(0, 8)}`);
      return;
    }

    const providerCfg = this.providers[action.provider];
    if (!providerCfg) {
      console.error(`[orcd] handleCreate: unknown provider ${action.provider}`);
      this.send(client, { type: 'error', sessionId: '', error: `unknown provider: ${action.provider}` });
      return;
    }

    const session = new OrcdSession({
      cwd: action.cwd,
      model: action.model,
      provider: action.provider,
      providerConfig: providerCfg,
      providers: this.providers,
      sessionId: action.sessionId,
      contextWindow: action.contextWindow,
      summarizeThreshold: action.summarizeThreshold,
      bufferSize: this.opts.ringBufferSize,
      onFork: (oldId, newId) => this.store.alias(oldId, newId),
    });

    this.store.add(session);
    this.attachLifecycleHooks(session);

    // Auto-subscribe the creating client
    const cb: SessionEventCallback = (msg) => this.send(client, msg);
    client.subscriptions.set(session.id, cb);
    session.subscribe(cb);

    this.send(client, { type: 'session_created', sessionId: session.id });

    const effort = action.effort ?? 'high';

    session
      .run({
        prompt: action.prompt,
        resume: !!action.sessionId,
        effort,
      })
      .finally(() => {
        console.log(`[orcd] session ${session.id.slice(0, 8)} exited (state=${session.state})`);
      });
  }

  // Re-arm a session's scheduled jobs after an orcd restart without running a
  // turn. If the session is already resident (and thus already armed), just
  // re-confirm it to the caller. Otherwise resume it and hold it open via
  // OrcdSession.warm() until its scheduled jobs fire.
  private handleWarm(client: ClientState, action: OrcdAction & { action: 'warm' }): void {
    const existing = this.store.get(action.sessionId);
    if (existing) {
      console.log(`[orcd:${existing.id.slice(0, 8)}] warm: session already resident, re-confirming`);
      this.send(client, { type: 'session_created', sessionId: existing.id });
      return;
    }

    const providerCfg = this.providers[action.provider];
    if (!providerCfg) {
      console.error(`[orcd] handleWarm: unknown provider ${action.provider}`);
      this.send(client, { type: 'error', sessionId: '', error: `unknown provider: ${action.provider}` });
      return;
    }

    const session = new OrcdSession({
      cwd: action.cwd,
      model: action.model,
      provider: action.provider,
      providerConfig: providerCfg,
      providers: this.providers,
      sessionId: action.sessionId,
      contextWindow: action.contextWindow,
      summarizeThreshold: action.summarizeThreshold,
      onFork: (oldId, newId) => this.store.alias(oldId, newId),
    });

    this.store.add(session);
    this.attachLifecycleHooks(session);

    const cb: SessionEventCallback = (msg) => this.send(client, msg);
    client.subscriptions.set(session.id, cb);
    session.subscribe(cb);

    this.send(client, { type: 'session_created', sessionId: session.id });

    session.warm().finally(() => {
      console.log(`[orcd] warmed session ${session.id.slice(0, 8)} exited (state=${session.state})`);
    });
  }

  private handleMessage(client: ClientState, action: OrcdAction & { action: 'message' }): void {
    const session = this.store.get(action.sessionId);
    if (!session) {
      console.error(`[orcd:${action.sessionId.slice(0, 8)}] handleMessage: session not found`);
      this.send(client, { type: 'error', sessionId: action.sessionId, error: 'session not found' });
      return;
    }

    // Ensure client is subscribed
    if (!client.subscriptions.has(session.id)) {
      const cb: SessionEventCallback = (msg) => this.send(client, msg);
      client.subscriptions.set(session.id, cb);
      session.subscribe(cb);
    }

    // `/compact` (and other Pi TUI slash commands) are not interpreted on the
    // headless SDK path — without this they reach the model as literal prompt
    // text. The chat command runs Pi's full native compaction (the UI context
    // wheel uses the same full compaction via the `compact` action).
    if (isCompactCommand(action.prompt)) {
      console.log(`[orcd:${session.id.slice(0, 8)}] /compact command detected → full compaction`);
      void this.runFullCompaction(session);
      return;
    }

    if (!action.prompt.trim()) {
      console.warn(`[orcd:${action.sessionId.slice(0, 8)}] handleMessage: empty prompt, dropping`);
      this.send(client, { type: 'error', sessionId: action.sessionId, error: 'empty prompt' });
      return;
    }

    // Pi rejects prompts while its blocking manual compactor is mutating the
    // session. Match the TUI: hold messages submitted during `/compact`, then
    // start them as soon as compaction finishes.
    if (this.compactionQueuedMessages.has(session.id)) {
      const queued = this.compactionQueuedMessages.get(session.id) ?? [];
      queued.push(action.prompt);
      this.compactionQueuedMessages.set(session.id, queued);
      console.log(`[orcd:${session.id.slice(0, 8)}:compact] queued message for after compaction`);
      return;
    }

    session.sendMessage(action.prompt, action.effort).finally(() => {
      console.log(`[orcd] session ${session.id.slice(0, 8)} follow-up exited (state=${session.state})`);
    });
  }

  private handleSetEffort(action: OrcdAction & { action: 'set_effort' }): void {
    const session = this.store.get(action.sessionId);
    session?.setEffort(action.effort).catch((err: unknown) => {
      console.error(`[orcd] setEffort error:`, err);
    });
  }

  private handleSetSummarizeThreshold(action: OrcdAction & { action: 'set_summarize_threshold' }): void {
    const session = this.store.get(action.sessionId);
    session?.setSummarizeThreshold(action.summarizeThreshold);
  }

  private handleSetModel(action: OrcdAction & { action: 'set_model' }): void {
    const session = this.store.get(action.sessionId);
    if (!session) {
      console.warn(`[orcd:${action.sessionId.slice(0, 8)}] set_model: session not resident, ignoring`);
      return;
    }
    const cfg = this.providers[action.provider];
    if (!cfg) {
      console.error(`[orcd:${session.id.slice(0, 8)}] set_model: unknown provider ${action.provider}`);
      return;
    }
    session.setModel(action.provider, action.model, cfg).catch((err: unknown) => {
      console.error(`[orcd:${session.id.slice(0, 8)}] setModel error:`, err instanceof Error ? err.message : String(err));
    });
  }

  private handleSubscribe(client: ClientState, action: OrcdAction & { action: 'subscribe' }): void {
    const session = this.store.get(action.sessionId);
    if (!session) {
      console.log(`[orcd:${action.sessionId.slice(0, 8)}] handleSubscribe: session not found, ignoring`);
      return;
    }

    if (client.subscriptions.has(session.id)) {
      console.log(
        `[orcd:${session.id.slice(0, 8)}] handleSubscribe: client already subscribed, replaying from ${action.afterEventIndex}`,
      );
      if (action.afterEventIndex !== undefined) {
        session.replay(action.afterEventIndex, (msg) => this.send(client, msg));
      }
      return;
    }

    const cb: SessionEventCallback = (msg) => this.send(client, msg);
    client.subscriptions.set(session.id, cb);
    session.subscribe(cb);

    session.replay(action.afterEventIndex, (msg) => this.send(client, msg));
  }

  private handleUnsubscribe(client: ClientState, action: OrcdAction & { action: 'unsubscribe' }): void {
    const cb = client.subscriptions.get(action.sessionId);
    if (cb) {
      this.store.get(action.sessionId)?.unsubscribe(cb);
      client.subscriptions.delete(action.sessionId);
    }
  }

  private handleCancel(action: OrcdAction & { action: 'cancel' }): void {
    const session = this.store.get(action.sessionId);
    session?.cancel().catch((err: unknown) => {
      console.error(`[orcd] cancel error:`, err);
    });
  }

  private handleClose(action: OrcdAction & { action: 'close' }): void {
    const session = this.store.get(action.sessionId);
    if (!session) {
      console.log(`[orcd] close ignored: session ${action.sessionId.slice(0, 8)} not resident`);
      return;
    }
    this.store.remove(action.sessionId);
    session.dispose().catch((err: unknown) => {
      console.error(`[orcd] close error for session ${action.sessionId.slice(0, 8)}:`, err);
    });
  }

  private handleCompact(client: ClientState, action: OrcdAction & { action: 'compact' }): void {
    let session = this.store.get(action.sessionId);
    const hydrated = !session;
    if (!session) {
      session = new OrcdSession({
        cwd: action.cwd,
        model: action.model,
        provider: action.provider,
        providerConfig: this.providers[action.provider],
        providers: this.providers,
        sessionId: action.sessionId,
        contextWindow: action.contextWindow,
        summarizeThreshold: action.summarizeThreshold,
        bufferSize: this.opts.ringBufferSize,
      });
      session.state = 'completed';
      this.store.add(session);
      this.attachLifecycleHooks(session);
      console.log(`[orcd:${session.id.slice(0, 8)}:bgc] rehydrated inactive session for manual compact`);
    }
    if (!client.subscriptions.has(session.id)) {
      const cb: SessionEventCallback = (msg) => this.send(client, msg);
      client.subscriptions.set(session.id, cb);
      session.subscribe(cb);
    }
    const run = action.mode === 'full' ? this.runFullCompaction(session) : this.maybeStartBgc(session);
    void run.finally(() => {
      if (hydrated) this.store.remove(session.id);
    });
  }

  // ── Worktree / path actions ────────────────────────────────────────────────

  private async handleWorktreePrepare(client: ClientState, action: OrcdAction & { action: 'worktree_prepare' }): Promise<void> {
    try {
      const { prepareWorktree } = await import('./worktree-ops');
      const res = await prepareWorktree({
        projectPath: action.projectPath, branch: action.branch,
        sourceBranch: action.sourceBranch, setupCommands: action.setupCommands,
      });
      this.send(client, { type: 'worktree_ready', requestId: action.requestId, path: res.path, branch: res.branch });
    } catch (err) {
      console.error(`[orcd] worktree_prepare failed (${action.branch}):`, err instanceof Error ? err.message : err);
      this.send(client, { type: 'error', sessionId: '', requestId: action.requestId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleWorktreeRemove(client: ClientState, action: OrcdAction & { action: 'worktree_remove' }): Promise<void> {
    try {
      const { existsSync } = await import('fs');
      const { removeWorktree } = await import('./worktree-ops');
      if (existsSync(action.path)) removeWorktree(action.projectPath, action.path);
      this.send(client, { type: 'ok', requestId: action.requestId });
    } catch (err) {
      console.error(`[orcd] worktree_remove failed (${action.path}):`, err instanceof Error ? err.message : err);
      this.send(client, { type: 'error', sessionId: '', requestId: action.requestId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handlePathValidate(client: ClientState, action: OrcdAction & { action: 'path_validate' }): Promise<void> {
    const { validatePath } = await import('./worktree-ops');
    const res = await validatePath(action.path);
    this.send(client, { type: 'path_validated', requestId: action.requestId, ...res });
  }

  private async handleGetHistory(client: ClientState, action: OrcdAction & { action: 'get_history' }): Promise<void> {
    try {
      const { getPiSessionMessages } = await import('../lib/pi-session-history');
      const messages = await getPiSessionMessages(action.sessionId, action.cwd);
      this.send(client, { type: 'history', requestId: action.requestId, messages });
    } catch (err) {
      console.error(`[orcd] get_history error:`, err);
      this.send(client, { type: 'history', requestId: action.requestId, messages: [] });
    }
  }

  // ── Full compaction (chat `/compact`) ───────────────────────────────────

  /**
   * Pi's native blocking compaction — summarizes the whole conversation and
   * rebuilds context in one shot, the same behavior as `/compact` in the Pi TUI.
   *
   * A manual `/compact` runs session.compact() OUTSIDE a run(), so no Pi event
   * subscription is attached to map compaction_start/end → synthetic markers.
   * Emit the compact_started/compact_done pair explicitly here so the UI shows a
   * "Compacting context…" line and the card moves to running while it runs.
   * emitCompactStarted/Done are idempotent, so if a subscription is somehow
   * active it won't double-emit.
   */
  private readonly compactionQueuedMessages = new Map<string, string[]>();

  private async runFullCompaction(session: OrcdSession): Promise<void> {
    const sid = session.id;
    if (this.compacting.has(sid) || this.pendingApply.has(sid)) {
      console.log(`[orcd:${sid.slice(0, 8)}:compact] already in flight or pending, ignoring`);
      return;
    }
    this.compacting.add(sid);
    this.compactionQueuedMessages.set(sid, []);
    session.emitCompactStarted();
    try {
      await session.compact();
      console.log(`[orcd:${sid.slice(0, 8)}:compact] full compaction applied`);
    } catch (err) {
      console.error(`[orcd:${sid.slice(0, 8)}:compact] failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      session.emitCompactDone();
      this.compacting.delete(sid);

      const queued = this.compactionQueuedMessages.get(sid) ?? [];
      this.compactionQueuedMessages.delete(sid);
      if (queued.length > 0) {
        console.log(`[orcd:${sid.slice(0, 8)}:compact] sending ${queued.length} queued message(s)`);
        const [first, ...rest] = queued;
        const run = session.sendMessage(first);
        // Once the first call marks the session running, Pi natively queues the
        // rest as follow-ups in submission order.
        for (const prompt of rest) void session.sendMessage(prompt);
        void run.finally(() => {
          console.log(`[orcd] session ${sid.slice(0, 8)} post-compaction follow-up exited (state=${session.state})`);
        });
      }
    }
  }

  // ── Background compaction ───────────────────────────────────────────────

  private readonly BGC_KEEP_FRACTION = 0.5;

  /**
   * Background compactor. Summarize the oldest ~50% off-band (parallel-safe).
   * If the session is idle, splice the Pi-native compaction entry now; otherwise
   * defer the splice to the next run-end (onBeforeExit) — never mutate the agent
   * message array mid-run. Pi's own auto-compaction is the within-run safety net.
   */
  private async maybeStartBgc(session: OrcdSession): Promise<void> {
    const sid = session.id;
    if (this.compacting.has(sid) || this.pendingApply.has(sid)) {
      console.log(`[orcd:${sid.slice(0, 8)}:bgc] already in flight or pending, ignoring`);
      return;
    }
    this.compacting.add(sid);
    // Cancellation is not wired yet; summarization is short-lived.
    const signal = new AbortController().signal;
    try {
      session.emitBgcStarted();
      const result = await session.prepareBgCompaction(this.BGC_KEEP_FRACTION, signal);
      if (!result) {
        console.log(`[orcd:${sid.slice(0, 8)}:bgc] nothing to compact`);
        return;
      }
      if (session.isIdle()) {
        this.applyBgcResult(session, result);
      } else {
        this.pendingApply.set(sid, result);
        console.log(`[orcd:${sid.slice(0, 8)}:bgc] summary ready; deferring splice to run-end`);
      }
    } catch (err) {
      console.error(`[orcd:${sid.slice(0, 8)}:bgc] failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      this.compacting.delete(sid);
    }
  }

  /** Splice a prepared compaction unless Pi's safety net already compacted. */
  private applyBgcResult(session: OrcdSession, result: import('@earendil-works/pi-coding-agent').CompactionResult): void {
    if (session.latestEntryIsCompaction()) {
      console.log(`[orcd:${session.id.slice(0, 8)}:bgc] stale — a compaction already landed, skipping apply`);
      return;
    }
    session.applyBgCompaction(result);
    console.log(`[orcd:${session.id.slice(0, 8)}:bgc] applied (tokensBefore=${result.tokensBefore})`);
  }

  // ── Session lifecycle hooks (called from handleCreate) ──────────────────

  private attachLifecycleHooks(session: OrcdSession): void {
    const sid = session.id;

    // onBeforeExit hooks are persistent (fire on every run-end), so register the
    // deferred-splice apply once per session and make it one-shot via pendingApply.
    session.onBeforeExit(async () => {
      const pending = this.pendingApply.get(sid);
      // oxlint-disable-next-line orchestrel/log-before-early-return -- no pending splice is the common no-op case
      if (!pending) return;
      this.pendingApply.delete(sid);
      this.applyBgcResult(session, pending);
    });

    const hook: SessionEventCallback = (msg) => {
      if (msg.type === 'context_usage') {
        if (
          session.summarizeThreshold > 0 &&
          msg.contextWindow > 0 &&
          !this.compacting.has(sid) &&
          !this.pendingApply.has(sid) &&
          msg.contextTokens / msg.contextWindow >= session.summarizeThreshold
        ) {
          const pct = ((msg.contextTokens / msg.contextWindow) * 100).toFixed(0);
          console.log(`[orcd:${sid.slice(0, 8)}:bgc] threshold hit (${pct}%), starting`);
          void this.maybeStartBgc(session);
        }
      }
    };

    session.subscribe(hook);
  }
}
