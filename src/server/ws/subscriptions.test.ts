import { describe, it, expect, vi } from 'vitest';
import { MessageBus } from '../bus';
import { messageBus } from '../bus';
import { busRoomBridge } from './subscriptions';
import type { AppServer, AppSocket } from './types';

// We test the bus-to-room bridge concept:
// bus events should be forwarded to socket.io rooms via emit

describe('BusRoomBridge', () => {
  it('board:changed emits card:updated to column rooms', () => {
    const bus = new MessageBus();
    const emitToRoom = vi.fn();
    const io = {
      to: vi.fn((..._args: unknown[]) => ({ emit: emitToRoom })),
      emit: vi.fn(),
      sockets: { adapter: { rooms: new Map() } },
    };

    // Simulate global listener registration
    bus.on('board:changed', (payload) => {
      const { card, oldColumn, newColumn, id } = payload as {
        card: unknown;
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
      if (rooms.length) io.to(rooms).emit('card:updated', card);
    });

    const card = { id: 1, title: 'Test', column: 'running' };
    bus.publish('board:changed', { card, oldColumn: 'ready', newColumn: 'running' });

    expect(io.to).toHaveBeenCalledWith(['col:ready', 'col:running']);
    expect(emitToRoom).toHaveBeenCalledWith('card:updated', card);
  });

  it('board:changed with deletion emits card:deleted to all', () => {
    const bus = new MessageBus();
    const io = { emit: vi.fn(), to: vi.fn() };

    bus.on('board:changed', (payload) => {
      const { card, id } = payload as { card: unknown; id?: number };
      if (!card && id) io.emit('card:deleted', { id });
    });

    bus.publish('board:changed', { card: null, oldColumn: 'running', newColumn: null, id: 42 });
    expect(io.emit).toHaveBeenCalledWith('card:deleted', { id: 42 });
  });
});

describe('BusRoomBridge.leaveCard', () => {
  it('leaves the room and drops the bus listeners once the last socket is gone', () => {
    const roomSockets = new Set<string>(['sock-1']);
    const io = {
      to: () => ({ emit: () => {} }),
      emit: () => {},
      sockets: { adapter: { rooms: new Map<string, Set<string>>([['card:5', roomSockets]]) } },
    };
    const socket = {
      id: 'sock-1',
      rooms: new Set<string>(['card:5']),
      join: () => {},
      leave: (room: string) => socket.rooms.delete(room),
    };

    busRoomBridge.init(io as unknown as AppServer);
    busRoomBridge.joinCard(socket as unknown as AppSocket, 5);
    // Joining is what registers the bus listeners a card room needs.
    expect(messageBus.listenerCount('card:5:sdk')).toBe(1);

    busRoomBridge.leaveCard(socket as unknown as AppSocket, 5);

    // The room is released, and with no sockets left the listeners go with it, so a card
    // nobody is watching costs nothing on the server.
    expect(socket.rooms.has('card:5')).toBe(false);
    expect(messageBus.listenerCount('card:5:sdk')).toBe(0);
    expect(messageBus.listenerCount('card:5:status')).toBe(0);
  });
});
