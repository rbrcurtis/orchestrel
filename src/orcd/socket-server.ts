import { createServer, type Server, type Socket } from 'net';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { OrcdSession, type SessionEventCallback } from './session';
import { SessionStore } from './session-store';
import { expandSlashCommand } from './skill-resolver';
import type { OrcdAction, OrcdMessage } from '../shared/orcd-protocol';
import { buildModelAliasEnv, type ProviderConfig, type OrcdConfig } from './config';
import { prepareCompaction, applyCompaction, type PreparedCompaction } from '../lib/session-compactor';
import { upsertMemories } from '../lib/memory-upsert';

interface ClientState {
  socket: Socket;
  subscriptions: Map<string, SessionEventCallback>;
}

export class OrcdServer {
  private server: Server | null = null;
  private clients = new Set<ClientState>();
  readonly store = new SessionStore();
  private compacting = new Set<string>();  // session IDs currently compacting
  private pendingSummaries = new Map<string, PreparedCompaction>();
  private turnActive = new Set<string>();  // sessions with a turn in progress
  private upsertedSessions = new Set<string>();  // sessions that have had memory upsert run
  private memoryConfig?: OrcdConfig['memoryUpsert'];

  constructor(
    private socketPath: string,
    private providers: Record<string, ProviderConfig>,
    private defaults: { provider: string; model: string },
    memoryConfig?: OrcdConfig['memoryUpsert'],
  ) {
    this.memoryConfig = memoryConfig;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const dir = dirname(this.socketPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // Remove stale socket file
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);

      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        console.log(`[orcd] listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  stop(): void {
    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.server?.close();
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    console.log('[orcd] stopped');
  }

  private handleConnection(socket: Socket): void {
    const client: ClientState = { socket, subscriptions: new Map() };
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
    }
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

    const prompt = expandSlashCommand(action.prompt, action.cwd);

    session.run({
      prompt,
      resume: !!action.sessionId,
      env,
      effort,
    }).finally(() => {
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

    const prompt = expandSlashCommand(action.prompt, session.cwd);

    if (!prompt.trim()) {
      console.warn(`[orcd:${action.sessionId.slice(0, 8)}] handleMessage: empty prompt, dropping`);
      this.send(client, { type: 'error', sessionId: action.sessionId, error: 'empty prompt' });
      return;
    }

    session.sendMessage(prompt, env).finally(() => {
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
      console.log(`[orcd:${session.id.slice(0, 8)}] handleSubscribe: client already subscribed, replaying from ${action.afterEventIndex}`);
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

  // ── Provider env helper ──────────────────────────────────────────────────

  private buildProviderEnv(provider: string): Record<string, string> {
    const cfg = this.providers[provider];
    if (!cfg) {
      console.warn(`[orcd] buildProviderEnv: unknown provider ${provider}, using process.env only`);
      return { ...process.env } as Record<string, string>;
    }
    return Object.assign({}, process.env,
      { CC_BACKGROUND_COMPACTOR_DISABLE: '1' },
      cfg.baseUrl ? { ANTHROPIC_BASE_URL: cfg.baseUrl } : {},
      cfg.apiKey ? { ANTHROPIC_API_KEY: cfg.apiKey } : {},
      cfg.authToken ? { ANTHROPIC_AUTH_TOKEN: cfg.authToken } : {},
      buildModelAliasEnv(cfg.models),
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
    const pct = session.lastContextWindow > 0
      ? ((session.lastContextTokens / session.lastContextWindow) * 100).toFixed(0)
      : '?';
    log(`preparing summary (${session.lastContextTokens}/${session.lastContextWindow} = ${pct}%)`);

    const prepared = await prepareCompaction({
      sessionId: sid,
      projectPath: session.cwd,
      model: session.model,
      env,
    });

    if (this.turnActive.has(sid)) {
      this.pendingSummaries.set(sid, prepared);
      log(`summary ready (${prepared.messagesCovered}/${prepared.messagesBefore} msgs, ${prepared.summaryChars} chars, ${prepared.prepareDurationMs}ms) — turn active, waiting`);
    } else {
      log(`summary ready — session idle, applying now`);
      const result = await applyCompaction(prepared);
      log(`applied: ${result.messagesCovered}/${result.messagesBefore} msgs, ${result.summaryChars} chars`);
      session.emitCompactBoundary();
    }
  }

  // ── Session lifecycle hooks (called from handleCreate) ──────────────────

  private attachLifecycleHooks(session: OrcdSession): void {
    const sid = session.id;

    const hook: SessionEventCallback = (msg) => {
      if (msg.type === 'stream_event') {
        this.turnActive.add(sid);
      }

      if (msg.type === 'result') {
        this.turnActive.delete(sid);

        // Apply pending compaction at turn end (instant, session idle)
        const prepared = this.pendingSummaries.get(sid);
        if (prepared) {
          this.pendingSummaries.delete(sid);
          console.log(`[orcd:${sid.slice(0, 8)}:compact] applying pre-computed summary at turn end`);
          applyCompaction(prepared).then((r) => {
            console.log(`[orcd:${sid.slice(0, 8)}:compact] applied: ${r.messagesCovered}/${r.messagesBefore} msgs, ${r.summaryChars} chars`);
            session.emitCompactBoundary();
          }).catch((err) => {
            console.error(`[orcd:${sid.slice(0, 8)}:compact] apply failed:`, err);
          });
        }
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
          this.triggerCompaction(session).catch((err) => {
            console.error(`[orcd:${sid.slice(0, 8)}:compact] failed:`, err);
          }).finally(() => {
            this.compacting.delete(sid);
          });
        }
      }

      if (msg.type === 'session_exit') {
        // Cleanup
        this.compacting.delete(sid);
        this.pendingSummaries.delete(sid);
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
