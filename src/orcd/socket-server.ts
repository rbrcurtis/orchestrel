import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { dirname } from 'path';
import { upsertMemories } from '../lib/memory-upsert';
import type { OrcdAction, OrcdMessage } from '../shared/orcd-protocol';
import { isCompactCommand } from '../shared/slash-commands';
import type { OrcdConfig, ProviderConfig } from './config';
import { OrcdSession, type SessionEventCallback } from './session';
import { SessionStore } from './session-store';

interface ClientState {
  socket: Socket;
  subscriptions: Map<string, SessionEventCallback>;
}

export class OrcdServer {
  private server: Server | null = null;
  private clients = new Set<ClientState>();
  readonly store = new SessionStore();
  private compacting = new Set<string>(); // session IDs currently compacting
  private pendingApply = new Map<string, import('@earendil-works/pi-coding-agent').CompactionResult>();
  private upsertedSessions = new Set<string>(); // sessions that have had memory upsert run
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
      case 'compact':
        this.handleCompact(client, action);
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
      providerConfig: providerCfg,
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
    // text. Route the command to the real compaction signal instead.
    if (isCompactCommand(action.prompt)) {
      console.log(`[orcd:${session.id.slice(0, 8)}] /compact command detected → triggering compaction`);
      void this.maybeStartBgc(session);
      return;
    }

    if (!action.prompt.trim()) {
      console.warn(`[orcd:${action.sessionId.slice(0, 8)}] handleMessage: empty prompt, dropping`);
      this.send(client, { type: 'error', sessionId: action.sessionId, error: 'empty prompt' });
      return;
    }

    session.sendMessage(action.prompt).finally(() => {
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
        providerConfig: this.providers[action.provider],
        sessionId: action.sessionId,
        contextWindow: action.contextWindow,
        summarizeThreshold: action.summarizeThreshold,
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
    void this.maybeStartBgc(session).finally(() => {
      if (hydrated) this.store.remove(session.id);
    });
  }

  // ── Provider env helper ──────────────────────────────────────────────────

  private buildProviderEnv(provider: string): Record<string, string> {
    const cfg = this.providers[provider];
    if (!cfg) {
      console.warn(`[orcd] buildProviderEnv: unknown provider ${provider}, using process.env only`);
      return { ...process.env } as Record<string, string>;
    }

    // Pi runtime injects provider baseUrl/apiKey via the Model object and
    // AuthStorage.setRuntimeApiKey (see pi-runtime.ts) — not via process.env.
    // modelAliasEnv sets ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL for tiered
    // subagent model mapping, configured via the provider's `aliases` in config.yaml.
    return Object.assign({}, process.env, cfg.modelAliasEnv) as Record<string, string>;
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

      if (msg.type === 'session_exit') {
        // Auto memory upsert on exit
        this.runMemoryUpsert(session).catch((err) => {
          console.error(`[orcd:${sid.slice(0, 8)}:mem] exit upsert failed:`, err);
        });
      }
    };

    session.subscribe(hook);
  }
}
