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
  }

  onReconnect(cb: () => void | Promise<void>) {
    this.reconnectCb = cb;
  }

  getSubscribedColumns(): Column[] {
    return [...this.subscribedColumns];
  }

  async subscribe(columns: Column[]): Promise<SyncPayload | undefined> {
    this.subscribedColumns = columns;
    const res = await this.socket.emitWithAck('subscribe', columns);
    if (res.error) {
      console.error('[ws] subscribe error:', res.error);
      return undefined;
    }
    return res.data;
  }

  /** Generic ack-based emit. Throws on error response. */
  async emit(event: string, data: unknown): Promise<unknown> {
    const res = await (this.socket as AppSocket).emitWithAck(event as keyof ClientToServerEvents, data as never);
    const r = res as AckResponse;
    if (r && typeof r === 'object' && 'error' in r && r.error) {
      throw new Error(r.error);
    }
    return r && typeof r === 'object' && 'data' in r ? r.data : undefined;
  }

  dispose() {
    this.disposed = true;
    this.socket.disconnect();
  }
}
