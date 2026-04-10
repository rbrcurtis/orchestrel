import { createServer, type Server, type Socket } from 'net';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { OrcdSession, type SessionEventCallback } from './session';
import { SessionStore } from './session-store';
import { expandSlashCommand } from './skill-resolver';
import type { OrcdAction, OrcdMessage } from '../shared/orcd-protocol';
import type { ProviderConfig } from './config';

interface ClientState {
  socket: Socket;
  subscriptions: Map<string, SessionEventCallback>;
}

export class OrcdServer {
  private server: Server | null = null;
  private clients = new Set<ClientState>();
  readonly store = new SessionStore();

  constructor(
    private socketPath: string,
    private providers: Record<string, ProviderConfig>,
    private defaults: { provider: string; model: string },
  ) {}

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
    }
  }

  private handleCreate(client: ClientState, action: OrcdAction & { action: 'create' }): void {
    const providerCfg = this.providers[action.provider];
    if (!providerCfg) {
      this.send(client, { type: 'error', sessionId: '', error: `unknown provider: ${action.provider}` });
      return;
    }

    const session = new OrcdSession({
      cwd: action.cwd,
      model: action.model,
      provider: action.provider,
      sessionId: action.sessionId,
    });

    this.store.add(session);

    // Auto-subscribe the creating client
    const cb: SessionEventCallback = (msg) => this.send(client, msg);
    client.subscriptions.set(session.id, cb);
    session.subscribe(cb);

    this.send(client, { type: 'session_created', sessionId: session.id });

    const effort = action.effort ?? 'high';

    const env = Object.assign({}, process.env, {
      ANTHROPIC_BASE_URL: providerCfg.baseUrl,
      ANTHROPIC_API_KEY: providerCfg.apiKey,
      ...(providerCfg.authToken ? { ANTHROPIC_AUTH_TOKEN: providerCfg.authToken } : {}),
    }, action.env) as Record<string, string>;

    const prompt = action.sessionId ? action.prompt : expandSlashCommand(action.prompt, action.cwd);

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
      this.send(client, { type: 'error', sessionId: action.sessionId, error: 'session not found' });
      return;
    }

    // Ensure client is subscribed
    if (!client.subscriptions.has(session.id)) {
      const cb: SessionEventCallback = (msg) => this.send(client, msg);
      client.subscriptions.set(session.id, cb);
      session.subscribe(cb);
    }

    const providerCfg = this.providers[session.provider];
    const env = Object.assign({}, process.env, {
      ANTHROPIC_BASE_URL: providerCfg?.baseUrl ?? '',
      ANTHROPIC_API_KEY: providerCfg?.apiKey ?? '',
      ...(providerCfg?.authToken ? { ANTHROPIC_AUTH_TOKEN: providerCfg.authToken } : {}),
    }) as Record<string, string>;

    const prompt = expandSlashCommand(action.prompt, session.cwd);

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
    if (!session) return;

    if (client.subscriptions.has(session.id)) {
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
}
