import { createServer, type Server, type Socket } from 'net';
import { upsertMemories } from '../lib/memory-upsert';
import { applyCompaction, prepareCompaction, type PreparedCompaction } from '../lib/session-compactor';
import type { CapabilitiesMessage, OrcdAction, OrcdMessage } from '../shared/orcd-protocol';
import type { OrcdConfig, ProviderConfig } from './config';

export interface OrcdListenConfig {
  listen: { host: string; port: number };
  authToken: string;
  name: string;
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
  private pendingSummaries = new Map<string, PreparedCompaction>();
  private applyingSummaries = new Set<string>();
  private exitedSessions = new Set<string>(); // sessions that reached beforeExit
  private turnActive = new Set<string>(); // sessions with a turn in progress
  private upsertedSessions = new Set<string>(); // sessions that have had memory upsert run
  private memoryConfig?: OrcdConfig['memoryUpsert'];

  constructor(
    private opts: OrcdListenConfig,
    private providers: Record<string, ProviderConfig>,
    private defaults: { provider: string; model: string },
    memoryConfig?: OrcdConfig['memoryUpsert'],
  ) {
    this.memoryConfig = memoryConfig;
  }

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

  stop(): void {
    for (const client of this.clients) client.socket.destroy();
    this.server?.close();
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
      case 'set_effort':
        this.handleSetEffort(action);
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
      case 'memory_upsert':
        this.handleMemoryUpsert(action);
        break;
      case 'compact':
        this.handleCompact(client, action);
        break;
      case 'capabilities':
        this.send(client, this.buildCapabilities(action.requestId));
        break;
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
      sessionId: action.sessionId,
      contextWindow: action.contextWindow,
      summarizeThreshold: action.summarizeThreshold,
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

    const env = Object.assign(this.buildProviderEnv(action.provider), action.env) as Record<string, string>;

    session
      .run({
        prompt: action.prompt,
        resume: !!action.sessionId,
        env,
        effort,
      })
      .finally(() => {
        console.log(`[orcd] session ${session.id.slice(0, 8)} exited (state=${session.state})`);
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

    const env = this.buildProviderEnv(session.provider);

    if (!action.prompt.trim()) {
      console.warn(`[orcd:${action.sessionId.slice(0, 8)}] handleMessage: empty prompt, dropping`);
      this.send(client, { type: 'error', sessionId: action.sessionId, error: 'empty prompt' });
      return;
    }

    session.sendMessage(action.prompt, env).finally(() => {
      console.log(`[orcd] session ${session.id.slice(0, 8)} follow-up exited (state=${session.state})`);
    });
  }

  private handleSetEffort(action: OrcdAction & { action: 'set_effort' }): void {
    const session = this.store.get(action.sessionId);
    session?.setEffort(action.effort).catch((err: unknown) => {
      console.error(`[orcd] setEffort error:`, err);
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
      // Already subscribed — just replay from requested index
      session.replay(action.afterEventIndex, (msg) => this.send(client, msg));
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

  private handleMemoryUpsert(action: OrcdAction & { action: 'memory_upsert' }): void {
    const session = this.store.get(action.sessionId);
    if (!session) {
      console.log(`[orcd:${action.sessionId.slice(0, 8)}] handleMemoryUpsert: session not found, ignoring`);
      return;
    }
    this.runMemoryUpsert(session).catch((err) => {
      console.error(`[orcd:${session.id.slice(0, 8)}] memory_upsert action failed:`, err);
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
        sessionId: action.sessionId,
        contextWindow: action.contextWindow,
        summarizeThreshold: action.summarizeThreshold,
      });
      session.state = 'completed';
      this.store.add(session);
      this.attachLifecycleHooks(session);
      console.log(`[orcd:${session.id.slice(0, 8)}:compact] handleCompact: rehydrated inactive session`);
    }

    if (!client.subscriptions.has(session.id)) {
      const cb: SessionEventCallback = (msg) => this.send(client, msg);
      client.subscriptions.set(session.id, cb);
      session.subscribe(cb);
    }

    if (this.compacting.has(session.id) || this.pendingSummaries.has(session.id)) {
      console.log(`[orcd:${session.id.slice(0, 8)}:compact] handleCompact: already compacting or pending, ignoring`);
      return;
    }

    this.compacting.add(session.id);
    if (hydrated || session.state !== 'running') {
      this.exitedSessions.add(session.id);
    }
    session.emitBgcStarted();
    this.triggerCompaction(session)
      .catch((err) => {
        console.error(`[orcd:${session.id.slice(0, 8)}:compact] manual start failed:`, err);
      })
      .finally(() => {
        this.compacting.delete(session.id);
        if (hydrated) {
          this.pendingSummaries.delete(session.id);
          this.applyingSummaries.delete(session.id);
          this.exitedSessions.delete(session.id);
          this.turnActive.delete(session.id);
          this.store.remove(session.id);
        }
      });
  }

  // ── Provider env helper ──────────────────────────────────────────────────

  private buildProviderEnv(provider: string): Record<string, string> {
    const cfg = this.providers[provider];
    if (!cfg) {
      console.warn(`[orcd] buildProviderEnv: unknown provider ${provider}, using process.env only`);
      return { ...process.env } as Record<string, string>;
    }

    const providerConfig: Record<string, string> = {};
    if (cfg.type === 'bedrock') {
      providerConfig.CLAUDE_CODE_USE_BEDROCK = '1';
      if (cfg.region) providerConfig.AWS_REGION = cfg.region;
      if (cfg.profile) providerConfig.AWS_PROFILE = cfg.profile;
    } else {
      if (cfg.baseUrl) providerConfig.ANTHROPIC_BASE_URL = cfg.baseUrl;
      if (cfg.apiKey) providerConfig.ANTHROPIC_API_KEY = cfg.apiKey;
      if (cfg.authToken) providerConfig.ANTHROPIC_AUTH_TOKEN = cfg.authToken;
    }

    // modelAliasEnv sets ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL so the SDK's
    // internal subagent spawning (Explore agents, etc.) uses the provider's tiered
    // model mapping. Configured via the provider's `aliases` section in config.yaml
    // (or positional fallback if aliases absent). Single-model servers should set
    // all aliases to the same key to prevent model thrashing.
    return Object.assign(
      {},
      process.env,
      { CC_BACKGROUND_COMPACTOR_DISABLE: '1' },
      { ...providerConfig },
      cfg.modelAliasEnv,
    ) as Record<string, string>;
  }

  // ── Memory upsert ───────────────────────────────────────────────────────

  private async runMemoryUpsert(session: OrcdSession): Promise<void> {
    if (!this.memoryConfig?.enabled || !this.memoryConfig.baseUrl || !this.memoryConfig.apiKey) {
      console.log(`[orcd:${session.id.slice(0, 8)}:mem] memory upsert disabled or missing config, skipping`);
      return;
    }
    if (this.upsertedSessions.has(session.id)) {
      console.log(`[orcd:${session.id.slice(0, 8)}:mem] skipping duplicate upsert`);
      return;
    }

    const env = this.buildProviderEnv(session.provider);
    const log = (msg: string) => console.log(`[orcd:${session.id.slice(0, 8)}:mem] ${msg}`);

    log(`running agent (server: ${this.memoryConfig.baseUrl})`);

    const result = await upsertMemories({
      sessionId: session.id,
      projectPath: session.cwd,
      projectName: session.cwd.split('/').pop() ?? 'unknown',
      model: session.model,
      env,
      memoryBaseUrl: this.memoryConfig.baseUrl,
      memoryApiKey: this.memoryConfig.apiKey,
    });

    this.upsertedSessions.add(session.id);
    const { search, store, update, delete: del } = result.toolCalls;
    log(`done: search=${search} store=${store} update=${update} delete=${del} (${result.durationMs}ms)`);
  }

  // ── Compaction ──────────────────────────────────────────────────────────

  private async triggerCompaction(session: OrcdSession): Promise<void> {
    const sid = session.id;
    const log = (msg: string) => console.log(`[orcd:${sid.slice(0, 8)}:compact] ${msg}`);
    const env = this.buildProviderEnv(session.provider);

    // Memory upsert is NOT run here — it only runs on card finish
    // (session_exit = move to review, or explicit archive action). Running
    // it every compaction cycle produced redundant work against unchanged
    // context and wasted tokens. See memory 'Auto-memory upsert architecture'.

    // Prepare summary (read-only, safe while session runs)
    const pct =
      session.lastContextWindow > 0 ? ((session.lastContextTokens / session.lastContextWindow) * 100).toFixed(0) : '?';
    log(`preparing summary (${session.lastContextTokens}/${session.lastContextWindow} = ${pct}%)`);

    const prepared = await prepareCompaction({
      sessionId: sid,
      projectPath: session.cwd,
      model: session.model,
      env,
      contextWindow: session.contextWindow,
    });

    this.pendingSummaries.set(sid, prepared);
    if (this.exitedSessions.has(sid)) {
      log(
        `summary ready (${prepared.messagesCovered}/${prepared.messagesBefore} msgs, ${prepared.summaryChars} chars, ${prepared.prepareDurationMs}ms) — beforeExit already reached, applying now`,
      );
      await this.applyPendingCompaction(session);
      return;
    }
    log(
      `summary ready (${prepared.messagesCovered}/${prepared.messagesBefore} msgs, ${prepared.summaryChars} chars, ${prepared.prepareDurationMs}ms) — waiting for beforeExit`,
    );
  }

  private async applyPendingCompaction(session: OrcdSession): Promise<void> {
    const sid = session.id;
    if (this.applyingSummaries.has(sid)) {
      console.log(`[orcd:${sid.slice(0, 8)}:compact] summary apply already in progress`);
      return;
    }

    const prepared = this.pendingSummaries.get(sid);
    if (!prepared) {
      console.log(`[orcd:${sid.slice(0, 8)}:compact] no pending summary at beforeExit`);
      return;
    }

    this.applyingSummaries.add(sid);
    this.pendingSummaries.delete(sid);
    console.log(`[orcd:${sid.slice(0, 8)}:compact] applying pre-computed summary at beforeExit`);
    try {
      const result = await applyCompaction(prepared);
      console.log(
        `[orcd:${sid.slice(0, 8)}:compact] applied: ${result.messagesCovered}/${result.messagesBefore} msgs, ${result.summaryChars} chars`,
      );
      session.emitCompactBoundary();
    } finally {
      this.applyingSummaries.delete(sid);
    }
  }

  // ── Session lifecycle hooks (called from handleCreate) ──────────────────

  private attachLifecycleHooks(session: OrcdSession): void {
    const sid = session.id;

    session.onBeforeExit(async () => {
      this.exitedSessions.add(sid);
      try {
        await this.applyPendingCompaction(session);
      } catch (err) {
        console.error(`[orcd:${sid.slice(0, 8)}:compact] beforeExit apply failed:`, err);
      }
    });

    const hook: SessionEventCallback = (msg) => {
      if (msg.type === 'stream_event') {
        const event = msg.event as Record<string, unknown>;
        if (event.type === 'message_start') {
          this.exitedSessions.delete(sid);
          this.turnActive.add(sid);
        }
      }

      if (msg.type === 'result') {
        this.turnActive.delete(sid);
      }

      if (msg.type === 'context_usage') {
        // Check threshold for auto-compaction
        if (
          session.summarizeThreshold > 0 &&
          msg.contextWindow > 0 &&
          !this.compacting.has(sid) &&
          !this.pendingSummaries.has(sid) &&
          msg.contextTokens / msg.contextWindow >= session.summarizeThreshold
        ) {
          this.compacting.add(sid);
          const pct = ((msg.contextTokens / msg.contextWindow) * 100).toFixed(0);
          console.log(`[orcd:${sid.slice(0, 8)}:compact] threshold hit (${pct}%), starting`);
          session.emitBgcStarted();
          this.triggerCompaction(session)
            .catch((err) => {
              console.error(`[orcd:${sid.slice(0, 8)}:compact] failed:`, err);
            })
            .finally(() => {
              this.compacting.delete(sid);
            });
        }
      }

      if (msg.type === 'session_exit') {
        // Do not clear compacting/pending summary state here.
        // A background compaction may still be preparing after the agent turn
        // exits, and clearing the guard early allows a resumed session to start
        // another compaction before the first one finishes.
        this.turnActive.delete(sid);

        // Auto memory upsert on exit
        this.runMemoryUpsert(session).catch((err) => {
          console.error(`[orcd:${sid.slice(0, 8)}:mem] exit upsert failed:`, err);
        });
      }
    };

    session.subscribe(hook);
  }
}
