import type { WebSocket } from 'ws'
import { messageBus, MessageBus } from '../bus'

export class ClientSubscriptions {
  private subs = new Map<WebSocket, Map<string, (payload: unknown) => void>>()

  constructor(private bus: MessageBus = messageBus) {}

  subscribe(ws: WebSocket, topic: string, handler: (payload: unknown) => void): void {
    if (!this.subs.has(ws)) this.subs.set(ws, new Map())
    const existing = this.subs.get(ws)!.get(topic)
    if (existing) this.bus.unsubscribe(topic, existing)
    this.subs.get(ws)!.set(topic, handler)
    this.bus.subscribe(topic, handler)
  }

  unsubscribe(ws: WebSocket, topic: string): void {
    const handler = this.subs.get(ws)?.get(topic)
    if (!handler) return
    this.bus.unsubscribe(topic, handler)
    this.subs.get(ws)!.delete(topic)
  }

  unsubscribeAll(ws: WebSocket): void {
    const topics = this.subs.get(ws)
    if (!topics) return
    for (const [topic, handler] of topics) {
      this.bus.unsubscribe(topic, handler)
    }
    this.subs.delete(ws)
  }
}

export const clientSubs = new ClientSubscriptions()
