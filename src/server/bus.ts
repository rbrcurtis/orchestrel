import { EventEmitter } from 'events';

export interface BoardChangedPayload {
  card: import('./models/Card').Card | null;
  oldColumn: string | null;
  newColumn: string | null;
  id?: number;
}

export interface SessionExitPayload {
  cardId: number;
  active: boolean;
  status: string;
  sessionId: string | null;
  promptsSent: number;
  turnsCompleted: number;
}

export class MessageBus extends EventEmitter {
  publish(topic: string, payload: unknown): void {
    const count = this.listenerCount(topic);
    if (topic.includes(':message') || topic.includes(':session-status')) {
      const msg = payload as { type?: string; meta?: { subtype?: string } };
      console.log(
        `[bus] publish topic=${topic} listeners=${count} msgType=${msg.type ?? '?'} subtype=${msg.meta?.subtype ?? '-'}`,
      );
    }
    this.emit(topic, payload);
  }

  subscribe(topic: string, handler: (payload: unknown) => void): void {
    this.on(topic, handler);
  }

  unsubscribe(topic: string, handler: (payload: unknown) => void): void {
    this.removeListener(topic, handler);
  }
}

export const messageBus = new MessageBus();
messageBus.setMaxListeners(200);
