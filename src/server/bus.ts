import { EventEmitter } from 'events'

export class MessageBus extends EventEmitter {
  publish(topic: string, payload: unknown): void {
    this.emit(topic, payload)
  }

  subscribe(topic: string, handler: (payload: unknown) => void): void {
    this.on(topic, handler)
  }

  unsubscribe(topic: string, handler: (payload: unknown) => void): void {
    this.removeListener(topic, handler)
  }
}

export const messageBus = new MessageBus()
messageBus.setMaxListeners(200)
