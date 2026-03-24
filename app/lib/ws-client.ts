import { serverMessage, type ClientMessage, type Column, type ServerMessage } from '../../src/shared/ws-protocol';

type EntityHandler = (msg: ServerMessage) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private onEntity: EntityHandler;
  private subscribedColumns: Column[] = [];
  private reconnectAttempt = 0;
  private maxReconnectDelay = 30_000;
  private disposed = false;
  private sendQueue: string[] = [];
  private reconnectCb: (() => void) | null = null;

  private lastConnectTime = 0;

  constructor(onEntity: EntityHandler) {
    this.onEntity = onEntity;
    this.connect();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.checkAlive();
      });
    }
  }

  /** Force-reconnect if the socket looks dead after iOS resume */
  private checkAlive() {
    if (this.disposed || !this.ws) return;
    // If we connected very recently, skip the check
    if (Date.now() - this.lastConnectTime < 3_000) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // The socket thinks it's open, but the TCP connection may be dead.
    // Send a no-op message and if the socket errors, onclose → reconnect.
    // As a fallback, force-close if we don't get any response in 3s.
    const ws = this.ws; // capture ref — don't close a newer socket if this one dies naturally
    const timer = setTimeout(() => {
      if (this.ws !== ws) return; // socket already replaced by a reconnect
      console.warn('[ws] no response after resume, forcing reconnect');
      ws.close();
    }, 3_000);
    // Any incoming message proves the connection is alive
    const origHandler = ws.onmessage;
    ws.onmessage = (evt) => {
      clearTimeout(timer);
      ws.onmessage = origHandler;
      origHandler?.call(ws, evt);
    };
    // Send a subscribe re-send (idempotent, already tracked server-side)
    if (this.subscribedColumns.length > 0) {
      this.send({ type: 'subscribe', columns: this.subscribedColumns });
    }
  }

  private get wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  private connect() {
    if (this.disposed) return;
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onopen = () => {
      const isReconnect = this.reconnectAttempt > 0;
      this.reconnectAttempt = 0;
      this.lastConnectTime = Date.now();
      if (this.subscribedColumns.length > 0) {
        this.send({ type: 'subscribe', columns: this.subscribedColumns });
      }
      // Flush messages queued while connecting
      for (const raw of this.sendQueue) {
        this.ws!.send(raw);
      }
      this.sendQueue = [];
      if (isReconnect) this.reconnectCb?.();
    };
    this.ws.onmessage = (evt) => this.handleRaw(evt.data as string);
    this.ws.onclose = () => {
      if (!this.disposed) this.scheduleReconnect();
    };
    this.ws.onerror = () => this.ws?.close();
  }

  private scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay);
    this.reconnectAttempt++;
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('WebSocket disconnected'));
    }
    this.pending.clear();
    this.sendQueue = [];
    setTimeout(() => this.connect(), delay);
  }

  private handleRaw(raw: string) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const msg = serverMessage.parse(parsed);
      if (msg.type === 'mutation:ok' || msg.type === 'mutation:error') {
        const p = this.pending.get(msg.requestId);
        if (p) {
          clearTimeout(p.timeout);
          this.pending.delete(msg.requestId);
          if (msg.type === 'mutation:ok') p.resolve(msg.data);
          else p.reject(new Error(msg.error));
        }
      } else {
        this.onEntity(msg);
      }
    } catch (err) {
      console.error('[ws] parse error:', err);
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Force-close and immediately reconnect (manual recovery for PWA resume) */
  forceReconnect() {
    if (this.disposed) return;
    console.log('[ws] force reconnect requested');
    // Close triggers onclose → scheduleReconnect with exponential backoff.
    // Instead, reset attempt counter so reconnect is instant.
    this.reconnectAttempt = 0;
    this.ws?.close();
  }

  send(msg: ClientMessage) {
    const raw = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.sendQueue.push(raw);
    }
  }

  onReconnect(cb: () => void) {
    this.reconnectCb = cb;
  }

  subscribe(columns: Column[]) {
    this.subscribedColumns = columns;
    this.send({ type: 'subscribe', columns });
  }

  async mutate<T = unknown>(msg: ClientMessage & { requestId: string }): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg.requestId);
        reject(new Error('Mutation timeout'));
      }, 15_000);
      this.pending.set(msg.requestId, { resolve: resolve as (data: unknown) => void, reject, timeout });
      this.send(msg);
    });
  }

  dispose() {
    this.disposed = true;
    this.ws?.close();
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('Disposed'));
    }
    this.pending.clear();
  }
}
