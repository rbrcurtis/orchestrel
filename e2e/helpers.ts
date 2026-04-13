import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SyncPayload,
  Card,
  AckResponse,
  AgentStatus,
} from '../src/shared/ws-protocol';

const BASE_URL = process.env.E2E_URL ?? 'http://localhost:6196';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Connect a Socket.IO client to orchestrel-pi. */
export function connect(): Promise<AppSocket> {
  return new Promise((resolve, reject) => {
    const socket: AppSocket = io(BASE_URL, {
      transports: ['websocket'],
      timeout: 10_000,
    }) as AppSocket;

    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(new Error(`Socket.IO connect failed: ${err.message}`)));

    setTimeout(() => reject(new Error('Socket.IO connect timeout')), 10_000);
  });
}

/** Subscribe to columns and get sync payload. */
export function subscribe(
  socket: AppSocket,
  columns: string[] = ['backlog', 'ready', 'running', 'review', 'done'],
): Promise<SyncPayload> {
  return new Promise((resolve, reject) => {
    socket.emit('subscribe', columns as never, (res: AckResponse<SyncPayload>) => {
      if (res.error) reject(new Error(res.error));
      else resolve(res.data!);
    });
    setTimeout(() => reject(new Error('subscribe timeout')), 10_000);
  });
}

/** Emit a typed event with ack and return the result. */
export function emit<T>(
  socket: AppSocket,
  event: string,
  data: unknown,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    (socket as Socket).emit(event, data, (res: AckResponse<T>) => {
      if (res.error) reject(new Error(res.error));
      else resolve(res.data as T);
    });
    setTimeout(() => reject(new Error(`${event} timeout`)), timeoutMs);
  });
}

/** Wait for a specific server push event that matches a predicate. */
export function waitForEvent<T>(
  socket: AppSocket,
  event: string,
  predicate: (data: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      (socket as Socket).off(event, handler);
      reject(new Error(`waitForEvent(${event}) timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (data: T) => {
      if (predicate(data)) {
        clearTimeout(timer);
        (socket as Socket).off(event, handler);
        resolve(data);
      }
    };

    (socket as Socket).on(event, handler);
  });
}

/** Wait for agent:status with specific cardId and condition. */
export function waitForAgentStatus(
  socket: AppSocket,
  cardId: number,
  predicate: (status: AgentStatus) => boolean,
  timeoutMs = 90_000,
): Promise<AgentStatus> {
  return waitForEvent<AgentStatus>(
    socket,
    'agent:status',
    (s) => s.cardId === cardId && predicate(s),
    timeoutMs,
  );
}

/** Wait for card:updated with specific cardId and column. */
export function waitForCardInColumn(
  socket: AppSocket,
  cardId: number,
  column: string,
  timeoutMs = 90_000,
): Promise<Card> {
  return waitForEvent<Card>(
    socket,
    'card:updated',
    (c) => c.id === cardId && c.column === column,
    timeoutMs,
  );
}

/** Collect session:message events for a card. Returns a stop function. */
export function collectSessionMessages(
  socket: AppSocket,
  cardId: number,
): { messages: unknown[]; stop: () => void } {
  const messages: unknown[] = [];
  const handler = (data: { cardId: number; message: unknown }) => {
    if (data.cardId === cardId) messages.push(data.message);
  };
  (socket as Socket).on('session:message', handler);
  return {
    messages,
    stop: () => (socket as Socket).off('session:message', handler),
  };
}
