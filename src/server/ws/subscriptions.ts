import type { WebSocket } from 'ws';
import { messageBus, MessageBus } from '../bus';

export class ClientSubscriptions {
  private subs = new Map<WebSocket, Map<string, (payload: unknown) => void>>();

  constructor(private bus: MessageBus = messageBus) {}

  isSubscribed(ws: WebSocket, topic: string): boolean {
    return this.subs.get(ws)?.has(topic) ?? false;
  }

  /** All topics this ws is subscribed to */
  topicsFor(ws: WebSocket): string[] {
    return [...(this.subs.get(ws)?.keys() ?? [])];
  }

  /** How many ws clients are subscribed to a given topic (across all clients) */
  listenerCount(topic: string): number {
    let n = 0;
    for (const topics of this.subs.values()) {
      if (topics.has(topic)) n++;
    }
    return n;
  }

  subscribe(ws: WebSocket, topic: string, handler: (payload: unknown) => void): void {
    if (!this.subs.has(ws)) this.subs.set(ws, new Map());
    const existing = this.subs.get(ws)!.get(topic);
    if (existing) {
      console.log(`[clientSubs] replacing existing handler for topic=${topic}`);
      this.bus.unsubscribe(topic, existing);
    }
    this.subs.get(ws)!.set(topic, handler);
    this.bus.subscribe(topic, handler);
    console.log(
      `[clientSubs] subscribe topic=${topic} busListeners=${this.bus.listenerCount(topic)} wsTopics=${this.subs.get(ws)!.size}`,
    );
  }

  unsubscribe(ws: WebSocket, topic: string): void {
    const handler = this.subs.get(ws)?.get(topic);
    if (!handler) return;
    this.bus.unsubscribe(topic, handler);
    this.subs.get(ws)!.delete(topic);
  }

  unsubscribeAll(ws: WebSocket): void {
    const topics = this.subs.get(ws);
    if (!topics) return;
    for (const [topic, handler] of topics) {
      this.bus.unsubscribe(topic, handler);
    }
    this.subs.delete(ws);
  }
}

export const clientSubs = new ClientSubscriptions();
