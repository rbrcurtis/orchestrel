import { createConnection, type Socket } from 'net';
import type {
  OrcdAction,
  OrcdMessage,
} from '../shared/orcd-protocol';

export interface OrcdClientOpts {
  host: string;
  port: number;
  token: string;
  name: string;
}

type MessageHandler = (msg: OrcdMessage) => void | Promise<void>;

/**
 * Client for the orcd TCP socket.
 * Manages connection, reconnection, and message dispatch.
 */
export class OrcdClient {
  private socket: Socket | null = null;
  private buf = '';
  private connected = false;
  private hasConnectedBefore = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<MessageHandler>();
  private dispatchChain = Promise.resolve();
  private destroyed = false;

  readonly nodeName: string;
  private opts: OrcdClientOpts;

  /** Pending create calls, resolved in the same order orcd accepts them. */
  private pendingCreates: Array<{
    resolve: (sessionId: string) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  /** Generic requestId-based pending requests */
  private pending = new Map<string, { resolve: (m: OrcdMessage) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private reqCounter = 0;

  /** Cached capabilities from hello handshake */
  capabilities: import('../shared/orcd-protocol').CapabilitiesMessage | null = null;

  /** Track which sessions we consider active (running in orcd) */
  private activeSessions = new Set<string>();

  /** Callback invoked when OrcdClient reconnects (orcd restarted) */
  private reconnectCallback: (() => void) | null = null;

  constructor(opts: OrcdClientOpts) {
    this.opts = opts;
    this.nodeName = opts.name;
  }

  /**
   * Register a callback for when OrcdClient reconnects to orcd.
   * Fires on re-connections only (not the initial connect).
   */
  onReconnect(cb: () => void): void {
    this.reconnectCallback = cb;
  }

  /**
   * Connect to orcd. Reconnects automatically on disconnect.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.destroyed = false;
      const sock = createConnection({ host: this.opts.host, port: this.opts.port }, () => {
        this.connected = true;
        this.buf = '';
        const isReconnect = this.hasConnectedBefore;
        this.hasConnectedBefore = true;
        console.log(`[orcd-client:${this.nodeName}] ${isReconnect ? 're' : ''}connected`);
        this.sayHello()
          .then(() => { if (isReconnect) this.reconnectCallback?.(); resolve(); })
          .catch((err: Error) => { console.error(`[orcd-client:${this.nodeName}] hello failed:`, err.message); reject(err); });
      });

      sock.on('data', (data) => {
        this.buf += data.toString();
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) !== -1) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as OrcdMessage;
            this.dispatch(msg);
          } catch (err) {
            console.warn(`[orcd-client:${this.nodeName}] skipping malformed message:`, err instanceof Error ? err.message : err, 'line:', line.slice(0, 120));
          }
        }
      });

      sock.on('close', () => {
        this.connected = false;
        // activeSessions is stale after disconnect — orcd may have restarted.
        // Reconcile will re-seed from orcd.list() on reconnect.
        this.activeSessions.clear();
        if (this.destroyed) {
          console.log(`[orcd-client:${this.nodeName}] disconnected after explicit shutdown`);
          return;
        }
        console.log(`[orcd-client:${this.nodeName}] disconnected, reconnecting in 2s...`);
        this.reconnectTimer = setTimeout(() => {
          this.connect().catch((err) => {
            console.error(`[orcd-client:${this.nodeName}] reconnect failed:`, (err as Error).message);
          });
        }, 2000);
      });

      sock.on('error', (err) => {
        if (!this.connected) {
          if (!this.destroyed && !this.reconnectTimer) {
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              this.connect().catch((e) => console.error(`[orcd-client:${this.nodeName}] reconnect failed:`, (e as Error).message));
            }, 2000);
          }
          reject(err);
        } else {
          console.error(`[orcd-client:${this.nodeName}] socket error:`, err.message);
        }
      });

      this.socket = sock;
    });
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  /**
   * Register a handler for all messages from orcd.
   */
  onMessage(handler: MessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: MessageHandler): void {
    this.handlers.delete(handler);
  }

  /**
   * Send a raw action to orcd.
   */
  send(action: OrcdAction): void {
    if (!this.socket?.writable) {
      console.error(`[orcd-client:${this.nodeName}] not connected, dropping action:`, action.action);
      return;
    }
    this.socket.write(JSON.stringify(action) + '\n');
  }

  private nextRequestId(): string {
    return `${this.nodeName}-${Date.now()}-${this.reqCounter++}`;
  }

  private request(action: OrcdAction): Promise<OrcdMessage> {
    const requestId = this.nextRequestId();
    return new Promise((resolve, reject) => {
      if (!this.socket?.writable) {
        console.warn(`[orcd-client:${this.nodeName}] not connected, cannot send request: ${action.action}`);
        reject(new Error(`OrcdClient[${this.nodeName}] not connected`));
        return;
      }
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`request timeout: ${action.action}`));
      }, 130_000);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.send({ ...action, requestId });
    });
  }

  /**
   * Create a new session. Returns the session ID assigned by orcd.
   */
  async create(opts: {
    prompt: string;
    cwd: string;
    provider: string;
    model: string;
    effort?: string;
    sessionId?: string;
    env?: Record<string, string>;
    contextWindow?: number;
    summarizeThreshold?: number;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.writable) {
        console.error(`[orcd-client:${this.nodeName}] not connected, cannot create session`);
        reject(new Error('OrcdClient not connected'));
        return;
      }

      const pending = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const idx = this.pendingCreates.indexOf(pending);
          if (idx !== -1) this.pendingCreates.splice(idx, 1);
          reject(new Error('orcd create timeout'));
        }, 30_000),
      };
      this.pendingCreates.push(pending);

      this.send({
        action: 'create',
        prompt: opts.prompt,
        cwd: opts.cwd,
        provider: opts.provider,
        model: opts.model,
        effort: opts.effort,
        sessionId: opts.sessionId,
        env: opts.env,
        contextWindow: opts.contextWindow,
        summarizeThreshold: opts.summarizeThreshold,
      });
    });
  }

  /**
   * Send a follow-up message to an existing session.
   */
  message(sessionId: string, prompt: string): void {
    this.send({ action: 'message', sessionId, prompt });
  }

  /**
   * Cancel (abort) a session.
   */
  cancel(sessionId: string): void {
    this.send({ action: 'cancel', sessionId });
    this.activeSessions.delete(sessionId);
  }

  /**
   * Subscribe to a session's events.
   */
  subscribe(sessionId: string, afterEventIndex?: number): void {
    this.send({ action: 'subscribe', sessionId, afterEventIndex });
  }

  /**
   * Unsubscribe from a session's events.
   */
  unsubscribe(sessionId: string): void {
    this.send({ action: 'unsubscribe', sessionId });
  }

  /**
   * Change effort level for a session.
   */
  setEffort(sessionId: string, effort: string): void {
    this.send({ action: 'set_effort', sessionId, effort });
  }

  /**
   * Request memory upsert for a session (extract facts → store in memory API).
   */
  memoryUpsert(sessionId: string): void {
    this.send({ action: 'memory_upsert', sessionId });
  }

  /**
   * Start Orchestrel background compaction for a session.
   */
  compact(opts: {
    sessionId: string;
    cwd: string;
    provider: string;
    model: string;
    contextWindow?: number;
    summarizeThreshold?: number;
  }): void {
    this.send({ action: 'compact', ...opts });
  }

  /**
   * List all active sessions. Returns the session list from orcd.
   */
  list(): Promise<import('../shared/orcd-protocol').SessionListMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.offMessage(cb);
        reject(new Error('list timeout'));
      }, 5000);

      const cb = (msg: OrcdMessage) => {
        if (msg.type === 'session_list') {
          clearTimeout(timeout);
          this.offMessage(cb);
          resolve(msg);
        }
      };
      this.onMessage(cb);
      this.send({ action: 'list' });
    });
  }

  /**
   * Perform the hello handshake and cache capabilities.
   */
  async sayHello(): Promise<import('../shared/orcd-protocol').CapabilitiesMessage> {
    const msg = await this.request({ action: 'hello', token: this.opts.token } as OrcdAction);
    if (msg.type !== 'capabilities') throw new Error('expected capabilities reply to hello');
    this.capabilities = msg;
    return msg;
  }

  /**
   * Validate that a path exists on the remote node.
   */
  async pathValidate(path: string): Promise<{ exists: boolean; isGitRepo: boolean; defaultBranch: string | null }> {
    const msg = await this.request({ action: 'path_validate', path } as OrcdAction);
    if (msg.type !== 'path_validated') throw new Error('expected path_validated reply');
    return { exists: msg.exists, isGitRepo: msg.isGitRepo, defaultBranch: msg.defaultBranch };
  }

  /**
   * Prepare a worktree on the remote node.
   */
  async worktreePrepare(opts: { projectPath: string; branch: string; sourceBranch?: string; setupCommands?: string }): Promise<{ path: string; branch: string }> {
    const msg = await this.request({ action: 'worktree_prepare', ...opts } as OrcdAction);
    if (msg.type !== 'worktree_ready') throw new Error('expected worktree_ready reply');
    return { path: msg.path, branch: msg.branch };
  }

  /**
   * Remove a worktree on the remote node.
   */
  async worktreeRemove(projectPath: string, path: string): Promise<void> {
    const msg = await this.request({ action: 'worktree_remove', projectPath, path } as OrcdAction);
    if (msg.type !== 'ok') throw new Error('expected ok reply');
  }

  isConnected(): boolean {
    return this.connected;
  }

  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /**
   * Mark a session as active in the local tracking set and subscribe to its
   * events on the orcd socket. Used at startup to seed activeSessions for
   * sessions that survived a web server restart — subscribing ensures we
   * receive session_exit (and other events) even though this client connection
   * wasn't the one that originally created the session.
   */
  markActive(sessionId: string): void {
    this.activeSessions.add(sessionId);
    this.subscribe(sessionId);
  }

  private dispatch(msg: OrcdMessage): void {
    // Short-circuit: if the message carries a requestId matching a pending request, resolve it directly.
    // This only fires for messages sent via request(), never for create/list which don't set requestId.
    const anyMsg = msg as OrcdMessage & { requestId?: string };
    if (anyMsg.requestId && this.pending.has(anyMsg.requestId)) {
      const p = this.pending.get(anyMsg.requestId)!;
      clearTimeout(p.timeout);
      this.pending.delete(anyMsg.requestId);
      if (msg.type === 'error') p.reject(new Error((msg as { error: string }).error));
      else p.resolve(msg);
      console.log(`[orcd-client:${this.nodeName}] request ${anyMsg.requestId} resolved (${msg.type})`);
      return;
    }

    // Handle session_created for pending create calls
    if (msg.type === 'session_created') {
      this.activeSessions.add(msg.sessionId);
      const pending = this.pendingCreates.shift();
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(msg.sessionId);
      }
    }

    if (msg.type === 'error' && msg.sessionId === '') {
      const pending = this.pendingCreates.shift();
      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(msg.error));
      }
    }

    // Track session lifecycle — only on actual exit, not on result
    if (msg.type === 'session_exit') {
      this.activeSessions.delete(msg.sessionId);
    }

    // On CC session fork, also track the new id so isActive()/subscribe() work
    if (msg.type === 'session_id_update' && this.activeSessions.has(msg.sessionId)) {
      this.activeSessions.add(msg.newSessionId);
    }

    this.dispatchChain = this.dispatchChain
      .catch(() => {})
      .then(async () => {
        for (const handler of this.handlers) {
          try {
            await handler(msg);
          } catch (err) {
            console.error(`[orcd-client:${this.nodeName}] handler error:`, err);
          }
        }
      });
  }
}
