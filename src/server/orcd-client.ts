import { createConnection, type Socket } from 'net';
import { homedir } from 'os';
import type {
  OrcdAction,
  OrcdMessage,
} from '../shared/orcd-protocol';

type MessageHandler = (msg: OrcdMessage) => void;

/**
 * Client for the orcd Unix socket.
 * Manages connection, reconnection, and message dispatch.
 */
export class OrcdClient {
  private socket: Socket | null = null;
  private buf = '';
  private connected = false;
  private hasConnectedBefore = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<MessageHandler>();

  /** Per-session callbacks for create flow */
  private createCallbacks = new Map<string, (sessionId: string) => void>();

  /** Track which sessions we consider active (running in orcd) */
  private activeSessions = new Set<string>();

  /** Callback invoked when OrcdClient reconnects (orcd restarted) */
  private reconnectCallback: (() => void) | null = null;

  constructor(private socketPath?: string) {}

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
    const path = this.socketPath ?? `${homedir()}/.orc/orcd.sock`;
    return new Promise((resolve, reject) => {
      const sock = createConnection({ path }, () => {
        this.connected = true;
        this.buf = '';
        const isReconnect = this.hasConnectedBefore;
        this.hasConnectedBefore = true;
        console.log(`[orcd-client] ${isReconnect ? 're' : ''}connected`);
        if (isReconnect) {
          this.reconnectCallback?.();
        }
        resolve();
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
            console.warn(`[orcd-client] skipping malformed message:`, err instanceof Error ? err.message : err, 'line:', line.slice(0, 120));
          }
        }
      });

      sock.on('close', () => {
        this.connected = false;
        // activeSessions is stale after disconnect — orcd may have restarted.
        // Reconcile will re-seed from orcd.list() on reconnect.
        this.activeSessions.clear();
        console.log('[orcd-client] disconnected, reconnecting in 2s...');
        this.reconnectTimer = setTimeout(() => {
          this.connect().catch((err) => {
            console.error('[orcd-client] reconnect failed:', (err as Error).message);
          });
        }, 2000);
      });

      sock.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        } else {
          console.error('[orcd-client] socket error:', err.message);
        }
      });

      this.socket = sock;
    });
  }

  disconnect(): void {
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
      console.error('[orcd-client] not connected, dropping action:', action.action);
      return;
    }
    this.socket.write(JSON.stringify(action) + '\n');
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
    return new Promise((resolve) => {
      const tempCb = (sessionId: string) => resolve(sessionId);

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

      // The session_created message will have the sessionId.
      // Use a special "pending" slot — we only create one session at a time per flow.
      this.createCallbacks.set('_pending', tempCb);
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
    // Handle session_created for pending create calls
    if (msg.type === 'session_created') {
      this.activeSessions.add(msg.sessionId);
      const cb = this.createCallbacks.get('_pending');
      if (cb) {
        this.createCallbacks.delete('_pending');
        cb(msg.sessionId);
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

    // Forward to all registered handlers
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (err) {
        console.error('[orcd-client] handler error:', err);
      }
    }
  }
}
