import { messageBus } from '../bus';
import type { AppServer } from './types';
import type { Card as CardEntity } from '../models/Card';
import type { Card, AgentStatus } from '../../shared/ws-protocol';

let _io: AppServer | null = null;

/** Per-card bus listeners — cleaned up when room empties */
const cardListeners = new Map<number, Map<string, (payload: unknown) => void>>();

/** Global bus listeners — cleaned up on re-init (Vite restart) */
const globalListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

export const busRoomBridge = {
  /** Initialize with the Socket.IO server and register global bus listeners */
  init(io: AppServer) {
    // Clean up previous listeners (survives Vite dev restarts)
    for (const { event, handler } of globalListeners) {
      messageBus.removeListener(event, handler);
    }
    globalListeners.length = 0;

    for (const [cardId, listeners] of cardListeners) {
      for (const [suffix, handler] of listeners) {
        messageBus.removeListener(`card:${cardId}:${suffix}`, handler);
      }
    }
    cardListeners.clear();

    _io = io;

    // board:changed → emit to column rooms
    const boardHandler = (payload: unknown) => {
      const { card, oldColumn, newColumn, id } = payload as {
        card: CardEntity | null;
        oldColumn: string | null;
        newColumn: string | null;
        id?: number;
      };
      if (!card) {
        if (id) io.emit('card:deleted', { id });
        return;
      }
      const rooms: string[] = [];
      if (oldColumn) rooms.push(`col:${oldColumn}`);
      if (newColumn && newColumn !== oldColumn) rooms.push(`col:${newColumn}`);
      if (rooms.length) io.to(rooms).emit('card:updated', card as unknown as Card);
    };
    messageBus.on('board:changed', boardHandler);
    globalListeners.push({ event: 'board:changed', handler: boardHandler });

    // system:error → broadcast to all
    const errorHandler = (payload: unknown) => {
      const { message } = payload as { message: string };
      io.emit('session:message', {
        cardId: -1,
        message: { type: 'error', message, timestamp: Date.now() },
      });
    };
    messageBus.on('system:error', errorHandler);
    globalListeners.push({ event: 'system:error', handler: errorHandler });

    console.log('[bus-bridge] global listeners registered');
  },

  /** Ensure bus→room listeners exist for a card. Called when a socket joins card:N. */
  ensureCardListeners(cardId: number) {
    if (cardListeners.has(cardId)) return;
    if (!_io) throw new Error('BusRoomBridge not initialized');
    const io = _io;
    const room = `card:${cardId}`;
    const listeners = new Map<string, (payload: unknown) => void>();

    const sdkHandler = (msg: unknown) => {
      io.to(room).emit('session:message', { cardId, message: msg });
    };
    messageBus.on(`card:${cardId}:sdk`, sdkHandler);
    listeners.set('sdk', sdkHandler);

    const statusHandler = (data: unknown) => {
      io.to(room).emit('agent:status', data as AgentStatus);
    };
    messageBus.on(`card:${cardId}:status`, statusHandler);
    listeners.set('status', statusHandler);

    const contextHandler = async (payload: unknown) => {
      const ctx = payload as { contextTokens: number; contextWindow: number };
      const { Card: CardModel } = await import('../models/Card');
      const card = await CardModel.findOneBy({ id: cardId });
      io.to(room).emit('agent:status', {
        cardId,
        active: true,
        status: 'running' as const,
        sessionId: card?.sessionId ?? null,
        promptsSent: card?.promptsSent ?? 0,
        turnsCompleted: card?.turnsCompleted ?? 0,
        contextTokens: ctx.contextTokens,
        contextWindow: ctx.contextWindow,
      });
    };
    messageBus.on(`card:${cardId}:context`, contextHandler);
    listeners.set('context', contextHandler);

    const exitHandler = async (payload: unknown) => {
      const p = payload as { sessionId: string | null; status: string };
      const { Card: CardModel } = await import('../models/Card');
      const card = await CardModel.findOneBy({ id: cardId });
      io.to(room).emit('agent:status', {
        cardId,
        active: false,
        status: p.status as 'completed',
        sessionId: p.sessionId,
        promptsSent: card?.promptsSent ?? 0,
        turnsCompleted: card?.turnsCompleted ?? 0,
        contextTokens: card?.contextTokens ?? 0,
        contextWindow: card?.contextWindow ?? 200_000,
      });
    };
    messageBus.on(`card:${cardId}:exit`, exitHandler);
    listeners.set('exit', exitHandler);

    const updatedHandler = (payload: unknown) => {
      io.to(room).emit('card:updated', payload as Card);
    };
    messageBus.on(`card:${cardId}:updated`, updatedHandler);
    listeners.set('updated', updatedHandler);

    cardListeners.set(cardId, listeners);
    console.log(`[bus-bridge] card:${cardId} listeners registered`);
  },

  /** Clean up bus listeners for a card room if no sockets remain in it. */
  cleanupCardIfEmpty(cardId: number) {
    if (!_io) return;
    const room = `card:${cardId}`;
    const roomSockets = _io.sockets.adapter.rooms.get(room);
    if (roomSockets && roomSockets.size > 0) return;

    const listeners = cardListeners.get(cardId);
    if (!listeners) return;

    for (const [suffix, handler] of listeners) {
      messageBus.removeListener(`card:${cardId}:${suffix}`, handler);
    }
    cardListeners.delete(cardId);
    console.log(`[bus-bridge] card:${cardId} listeners cleaned up`);
  },
};
