import { describe, it, expect, vi } from 'vitest'
import { MessageBus } from './bus'

describe('MessageBus', () => {
  it('delivers published payload to subscriber', () => {
    const bus = new MessageBus()
    const handler = vi.fn()
    bus.subscribe('test:topic', handler)
    bus.publish('test:topic', { hello: 'world' })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({ hello: 'world' })
  })

  it('does not deliver after unsubscribe', () => {
    const bus = new MessageBus()
    const handler = vi.fn()
    bus.subscribe('test:topic', handler)
    bus.unsubscribe('test:topic', handler)
    bus.publish('test:topic', {})
    expect(handler).not.toHaveBeenCalled()
  })

  it('delivers to multiple subscribers on same topic', () => {
    const bus = new MessageBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    bus.subscribe('test:multi', h1)
    bus.subscribe('test:multi', h2)
    bus.publish('test:multi', 42)
    expect(h1).toHaveBeenCalledWith(42)
    expect(h2).toHaveBeenCalledWith(42)
  })

  it('only removes the specific handler when unsubscribing', () => {
    const bus = new MessageBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    bus.subscribe('test:partial', h1)
    bus.subscribe('test:partial', h2)
    bus.unsubscribe('test:partial', h1)
    bus.publish('test:partial', {})
    expect(h1).not.toHaveBeenCalled()
    expect(h2).toHaveBeenCalledOnce()
  })
})
