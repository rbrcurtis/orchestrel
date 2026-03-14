import { describe, it, expect, vi } from 'vitest'
import { ClientSubscriptions } from './subscriptions'
import { MessageBus } from '../bus'
import type { WebSocket } from 'ws'

describe('ClientSubscriptions', () => {
  it('subscribe registers handler and delivers events', () => {
    const bus = new MessageBus()
    const subs = new ClientSubscriptions(bus)
    const ws = {} as WebSocket
    const handler = vi.fn()
    subs.subscribe(ws, 'test:t', handler)
    bus.publish('test:t', 42)
    expect(handler).toHaveBeenCalledWith(42)
  })

  it('unsubscribeAll removes all handlers for a client', () => {
    const bus = new MessageBus()
    const subs = new ClientSubscriptions(bus)
    const ws = {} as WebSocket
    const h1 = vi.fn()
    const h2 = vi.fn()
    subs.subscribe(ws, 'test:a', h1)
    subs.subscribe(ws, 'test:b', h2)
    subs.unsubscribeAll(ws)
    bus.publish('test:a', {})
    bus.publish('test:b', {})
    expect(h1).not.toHaveBeenCalled()
    expect(h2).not.toHaveBeenCalled()
  })

  it('re-subscribing to same topic replaces old handler', () => {
    const bus = new MessageBus()
    const subs = new ClientSubscriptions(bus)
    const ws = {} as WebSocket
    const h1 = vi.fn()
    const h2 = vi.fn()
    subs.subscribe(ws, 'test:replace', h1)
    subs.subscribe(ws, 'test:replace', h2)
    bus.publish('test:replace', {})
    expect(h1).not.toHaveBeenCalled()
    expect(h2).toHaveBeenCalledOnce()
  })

  it('two clients are isolated — unsubscribeAll only removes one client', () => {
    const bus = new MessageBus()
    const subs = new ClientSubscriptions(bus)
    const ws1 = {} as WebSocket
    const ws2 = {} as WebSocket
    const h1 = vi.fn()
    const h2 = vi.fn()
    subs.subscribe(ws1, 'test:iso', h1)
    subs.subscribe(ws2, 'test:iso', h2)
    subs.unsubscribeAll(ws1)
    bus.publish('test:iso', {})
    expect(h1).not.toHaveBeenCalled()
    expect(h2).toHaveBeenCalledOnce()
  })
})
