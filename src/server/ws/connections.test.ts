import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConnectionManager } from './connections'
import type { WebSocket } from 'ws'
import type { ServerMessage } from '../../shared/ws-protocol'

function mockWs(): WebSocket {
  return { send: vi.fn(), readyState: 1 } as unknown as WebSocket
}

const syncMsg: ServerMessage = {
  type: 'sync',
  data: { cards: [], projects: [] },
}

const cardUpdatedMsg: ServerMessage = {
  type: 'card:updated',
  data: {
    card: {
      id: 1,
      title: 'Test',
      description: null,
      column: 'ready',
      position: 0,
      projectId: null,
      model: null,
      thinkingLevel: null,
      useWorktree: false,
      sourceBranch: null,
      worktreePath: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  },
}

describe('ConnectionManager', () => {
  let mgr: ConnectionManager

  beforeEach(() => {
    mgr = new ConnectionManager()
  })

  // 1. Registers and removes connections
  it('tracks size as connections are added and removed', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()

    expect(mgr.size).toBe(0)
    mgr.add(ws1)
    expect(mgr.size).toBe(1)
    mgr.add(ws2)
    expect(mgr.size).toBe(2)

    mgr.remove(ws1)
    expect(mgr.size).toBe(1)
    mgr.remove(ws2)
    expect(mgr.size).toBe(0)
  })

  it('ignores remove of unknown connection', () => {
    const ws = mockWs()
    expect(() => mgr.remove(ws)).not.toThrow()
    expect(mgr.size).toBe(0)
  })

  // 2. Tracks subscribed columns
  it('starts with empty subscribed columns', () => {
    const ws = mockWs()
    mgr.add(ws)
    expect(mgr.getSubscribedColumns(ws)).toEqual(new Set())
  })

  it('updates subscribed columns via subscribe()', () => {
    const ws = mockWs()
    mgr.add(ws)
    mgr.subscribe(ws, ['ready', 'in_progress'])
    expect(mgr.getSubscribedColumns(ws)).toEqual(new Set(['ready', 'in_progress']))
  })

  it('replaces columns on re-subscribe', () => {
    const ws = mockWs()
    mgr.add(ws)
    mgr.subscribe(ws, ['ready', 'in_progress'])
    mgr.subscribe(ws, ['done'])
    expect(mgr.getSubscribedColumns(ws)).toEqual(new Set(['done']))
  })

  it('returns empty set for unknown ws in getSubscribedColumns', () => {
    const ws = mockWs()
    expect(mgr.getSubscribedColumns(ws)).toEqual(new Set())
  })

  it('subscribe() is a no-op for unknown ws', () => {
    const ws = mockWs()
    expect(() => mgr.subscribe(ws, ['ready'])).not.toThrow()
  })

  // 3. Broadcasts to subscribed connections only
  it('broadcasts to connections subscribed to the affected column', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    mgr.add(ws1)
    mgr.add(ws2)
    mgr.subscribe(ws1, ['ready'])
    mgr.subscribe(ws2, ['done'])

    mgr.broadcast(cardUpdatedMsg, 'ready')

    expect(ws1.send).toHaveBeenCalledOnce()
    expect(ws2.send).not.toHaveBeenCalled()
  })

  it('does not broadcast to connections with no matching column', () => {
    const ws = mockWs()
    mgr.add(ws)
    mgr.subscribe(ws, ['backlog'])

    mgr.broadcast(cardUpdatedMsg, 'ready')

    expect(ws.send).not.toHaveBeenCalled()
  })

  it('does not broadcast to connections with no subscriptions when column filter set', () => {
    const ws = mockWs()
    mgr.add(ws)
    // no subscribe call — empty set

    mgr.broadcast(cardUpdatedMsg, 'ready')

    expect(ws.send).not.toHaveBeenCalled()
  })

  // 4. Broadcasts to all when no column filter (for projects)
  it('broadcasts to all connections when no affectedColumns provided', () => {
    const ws1 = mockWs()
    const ws2 = mockWs()
    const ws3 = mockWs()
    mgr.add(ws1)
    mgr.add(ws2)
    mgr.add(ws3)
    mgr.subscribe(ws1, ['ready'])
    // ws2 has no subscriptions, ws3 has no subscriptions

    mgr.broadcast(syncMsg) // no column filter

    expect(ws1.send).toHaveBeenCalledOnce()
    expect(ws2.send).toHaveBeenCalledOnce()
    expect(ws3.send).toHaveBeenCalledOnce()
  })

  // 5. Broadcasts card:move to both old and new column subscribers
  it('broadcasts to subscribers of EITHER old or new column on card move', () => {
    const wsOld = mockWs()
    const wsNew = mockWs()
    const wsOther = mockWs()
    mgr.add(wsOld)
    mgr.add(wsNew)
    mgr.add(wsOther)
    mgr.subscribe(wsOld, ['ready'])        // subscribed to old column
    mgr.subscribe(wsNew, ['in_progress'])  // subscribed to new column
    mgr.subscribe(wsOther, ['done'])       // irrelevant column

    // broadcast with both old and new columns
    mgr.broadcast(cardUpdatedMsg, 'ready', 'in_progress')

    expect(wsOld.send).toHaveBeenCalledOnce()
    expect(wsNew.send).toHaveBeenCalledOnce()
    expect(wsOther.send).not.toHaveBeenCalled()
  })

  it('broadcasts to connection subscribed to both old and new column only once', () => {
    const ws = mockWs()
    mgr.add(ws)
    mgr.subscribe(ws, ['ready', 'in_progress'])

    mgr.broadcast(cardUpdatedMsg, 'ready', 'in_progress')

    // should only send once — first matching column wins via some()
    expect(ws.send).toHaveBeenCalledOnce()
  })

  // send() to specific connection
  it('sends a message to a specific open connection', () => {
    const ws = mockWs()
    mgr.add(ws)
    mgr.send(ws, syncMsg)
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(syncMsg))
  })

  it('skips send() when ws is not OPEN', () => {
    const ws = { send: vi.fn(), readyState: 3 } as unknown as WebSocket // CLOSED
    mgr.add(ws)
    mgr.send(ws, syncMsg)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('skips broadcast() to non-OPEN connections', () => {
    const ws = { send: vi.fn(), readyState: 0 } as unknown as WebSocket // CONNECTING
    mgr.add(ws)
    mgr.subscribe(ws as unknown as WebSocket, ['ready'])

    mgr.broadcast(cardUpdatedMsg) // no column filter — would normally hit all

    expect(ws.send).not.toHaveBeenCalled()
  })

  it('sends serialized JSON', () => {
    const ws = mockWs()
    mgr.add(ws)
    mgr.subscribe(ws, ['ready'])
    mgr.broadcast(cardUpdatedMsg, 'ready')
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(cardUpdatedMsg))
  })
})
