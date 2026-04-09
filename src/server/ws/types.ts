import type { Socket, Server as IoServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../../shared/ws-protocol';

export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type AppServer = IoServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
