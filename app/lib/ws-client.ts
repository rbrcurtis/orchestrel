import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  Column,
  SyncPayload,
  AckResponse,
} from '../../src/shared/ws-protocol';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// An acknowledgement that never arrives must not wedge the caller. emitWithAck waits
// forever by default, and a stuck ack leaves the session store's pending count above
// zero, which disables the send button until the app is reloaded and leaves a card's
// history half loaded. A node that is busy, restarting or gone fails silently here.
const ACK_TIMEOUT_MS = 30_000;

export class WsClient {
  readonly socket: AppSocket;
  private subscribedColumns: Column[] = [];
  private reconnectCb: (() => void | Promise<void>) | null = null;
  private disposed = false;
  private hasConnectedOnce = false;

  constructor(handlers: {
    onSync: (data: SyncPayload) => void;
    onCardUpdated: (data: import('../../src/shared/ws-protocol').Card) => void;
    onCardDeleted: (data: { id: number }) => void;
    onProjectUpdated: (data: import('../../src/shared/ws-protocol').Project) => void;
    onProjectDeleted: (data: { id: number }) => void;
    onSessionMessage: (data: { cardId: number; message: unknown }) => void;
    onAgentStatus: (data: import('../../src/shared/ws-protocol').AgentStatus) => void;
  }) {
    this.socket = io({
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: Infinity,
      timeout: 10_000,
    });

    // Wire server→client events
    this.socket.on('sync', handlers.onSync);
    this.socket.on('card:updated', handlers.onCardUpdated);
    this.socket.on('card:deleted', handlers.onCardDeleted);
    this.socket.on('project:updated', handlers.onProjectUpdated);
    this.socket.on('project:deleted', handlers.onProjectDeleted);
    this.socket.on('session:message', handlers.onSessionMessage);
    this.socket.on('agent:status', handlers.onAgentStatus);

    this.socket.on('connect', () => {
      const wasConnectedBefore = this.hasConnectedOnce;
      this.hasConnectedOnce = true;
      console.log('[ws] connected');
      if (!wasConnectedBefore) return;
      console.log('[ws] resumed connection');
      Promise.resolve(this.reconnectCb?.()).catch((err: unknown) => {
        console.error('[ws] reconnect handler error:', err);
      });
    });

    this.socket.io.on('reconnect', () => {
      console.log('[ws] reconnected');
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[ws] disconnected:', reason);
    });

    this.socket.on('connect_error', (err) => {
      console.error('[ws] connect error:', err.message);
    });
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  forceReconnect() {
    if (this.disposed) return;
    console.log('[ws] force reconnect requested');
    this.socket.disconnect().connect();
    this.socket.io.open();
  }

  onReconnect(cb: () => void | Promise<void>) {
    this.reconnectCb = cb;
  }

  getSubscribedColumns(): Column[] {
    return [...this.subscribedColumns];
  }

  async subscribe(columns: Column[]): Promise<SyncPayload | undefined> {
    this.subscribedColumns = columns;
    const res = await this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck('subscribe', columns);
    if (res.error) {
      console.error('[ws] subscribe error:', res.error);
      return undefined;
    }
    return res.data;
  }

  /** Generic ack-based emit. Throws on error response or on a missing ack. */
  async emit(event: string, data: unknown): Promise<unknown> {
    let res: AckResponse;
    try {
      res = (await (this.socket as AppSocket)
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck(event as keyof ClientToServerEvents, data as never)) as AckResponse;
    } catch (err) {
      // Reported so a lost ack is visible in the console rather than looking like a
      // UI that quietly stopped responding.
      console.error(`[ws] no ack for ${event} within ${ACK_TIMEOUT_MS}ms`, err);
      throw err;
    }
    if (res && typeof res === 'object' && 'error' in res && res.error) {
      throw new Error(res.error);
    }
    return res && typeof res === 'object' && 'data' in res ? res.data : undefined;
  }

  dispose() {
    this.disposed = true;
    this.socket.disconnect();
  }
}
