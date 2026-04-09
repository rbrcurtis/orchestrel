import { describe, it, expect, vi } from 'vitest'
import { MessageBus } from '../bus'

// We test the bus-to-room bridge concept:
// bus events should be forwarded to socket.io rooms via emit

describe('BusRoomBridge', () => {
  it('board:changed emits card:updated to column rooms', () => {
    const bus = new MessageBus()
    const emitToRoom = vi.fn()
    const io = {
      to: vi.fn(() => ({ emit: emitToRoom })),
      emit: vi.fn(),
      sockets: { adapter: { rooms: new Map() } },
    }

    // Simulate global listener registration
    bus.on('board:changed', (payload) => {
      const { card, oldColumn, newColumn, id } = payload as {
        card: unknown; oldColumn: string | null; newColumn: string | null; id?: number;
      }
      if (!card) {
        if (id) io.emit('card:deleted', { id })
        return
      }
      const rooms: string[] = []
      if (oldColumn) rooms.push(`col:${oldColumn}`)
      if (newColumn && newColumn !== oldColumn) rooms.push(`col:${newColumn}`)
      if (rooms.length) io.to(rooms).emit('card:updated', card)
    })

    const card = { id: 1, title: 'Test', column: 'running' }
    bus.publish('board:changed', { card, oldColumn: 'ready', newColumn: 'running' })

    expect(io.to).toHaveBeenCalledWith(['col:ready', 'col:running'])
    expect(emitToRoom).toHaveBeenCalledWith('card:updated', card)
  })

  it('board:changed with deletion emits card:deleted to all', () => {
    const bus = new MessageBus()
    const io = { emit: vi.fn(), to: vi.fn() }

    bus.on('board:changed', (payload) => {
      const { card, id } = payload as { card: unknown; id?: number }
      if (!card && id) io.emit('card:deleted', { id })
    })

    bus.publish('board:changed', { card: null, oldColumn: 'running', newColumn: null, id: 42 })
    expect(io.emit).toHaveBeenCalledWith('card:deleted', { id: 42 })
  })
})
