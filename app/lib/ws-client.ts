import { serverMessage, type ClientMessage, type Column, type ServerMessage } from '../../src/shared/ws-protocol'

type EntityHandler = (msg: ServerMessage) => void

export class WsClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, {
    resolve: (data: unknown) => void
    reject: (err: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()
  private onEntity: EntityHandler
  private subscribedColumns: Column[] = []
  private reconnectAttempt = 0
  private maxReconnectDelay = 30_000
  private disposed = false
  private sendQueue: string[] = []
  private reconnectCb: (() => void) | null = null

  constructor(onEntity: EntityHandler) {
    this.onEntity = onEntity
    this.connect()
  }

  private get wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/ws`
  }

  private connect() {
    if (this.disposed) return
    this.ws = new WebSocket(this.wsUrl)
    this.ws.onopen = () => {
      const isReconnect = this.reconnectAttempt > 0
      this.reconnectAttempt = 0
      if (this.subscribedColumns.length > 0) {
        this.send({ type: 'subscribe', columns: this.subscribedColumns })
      }
      // Flush messages queued while connecting
      for (const raw of this.sendQueue) {
        this.ws!.send(raw)
      }
      this.sendQueue = []
      if (isReconnect) this.reconnectCb?.()
    }
    this.ws.onmessage = (evt) => this.handleRaw(evt.data as string)
    this.ws.onclose = () => { if (!this.disposed) this.scheduleReconnect() }
    this.ws.onerror = () => this.ws?.close()
  }

  private scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelay)
    this.reconnectAttempt++
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout)
      p.reject(new Error('WebSocket disconnected'))
    }
    this.pending.clear()
    this.sendQueue = []
    setTimeout(() => this.connect(), delay)
  }

  private handleRaw(raw: string) {
    try {
      const parsed = JSON.parse(raw) as unknown
      const msg = serverMessage.parse(parsed)
      if (msg.type === 'mutation:ok' || msg.type === 'mutation:error') {
        const p = this.pending.get(msg.requestId)
        if (p) {
          clearTimeout(p.timeout)
          this.pending.delete(msg.requestId)
          if (msg.type === 'mutation:ok') p.resolve(msg.data)
          else p.reject(new Error(msg.error))
        }
      } else {
        this.onEntity(msg)
      }
    } catch (err) {
      console.error('[ws] parse error:', err)
    }
  }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN }

  send(msg: ClientMessage) {
    const raw = JSON.stringify(msg)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw)
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.sendQueue.push(raw)
    }
  }

  onReconnect(cb: () => void) {
    this.reconnectCb = cb
  }

  subscribe(columns: Column[]) {
    this.subscribedColumns = columns
    this.send({ type: 'subscribe', columns })
  }

  async mutate<T = unknown>(msg: ClientMessage & { requestId: string }): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(msg.requestId)
        reject(new Error('Mutation timeout'))
      }, 15_000)
      this.pending.set(msg.requestId, { resolve: resolve as (data: unknown) => void, reject, timeout })
      this.send(msg)
    })
  }

  dispose() {
    this.disposed = true
    this.ws?.close()
    for (const [, p] of this.pending) { clearTimeout(p.timeout); p.reject(new Error('Disposed')) }
    this.pending.clear()
  }
}
