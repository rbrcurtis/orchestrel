import type { WebSocket } from 'ws'
import type { ServerMessage } from '../../shared/ws-protocol'

interface Connection {
  ws: WebSocket
  subscribedColumns: Set<string>
}

export class ConnectionManager {
  private connections = new Map<WebSocket, Connection>()

  get size() {
    return this.connections.size
  }

  add(ws: WebSocket) {
    this.connections.set(ws, { ws, subscribedColumns: new Set() })
  }

  remove(ws: WebSocket) {
    this.connections.delete(ws)
  }

  subscribe(ws: WebSocket, columns: string[]) {
    const conn = this.connections.get(ws)
    if (conn) conn.subscribedColumns = new Set(columns)
  }

  getSubscribedColumns(ws: WebSocket): Set<string> {
    return this.connections.get(ws)?.subscribedColumns ?? new Set()
  }

  broadcast(msg: ServerMessage, ...affectedColumns: string[]) {
    const raw = JSON.stringify(msg)
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState !== 1) continue // not OPEN
      if (
        affectedColumns.length === 0 ||
        affectedColumns.some(col => conn.subscribedColumns.has(col))
      ) {
        conn.ws.send(raw)
      }
    }
  }

  /** Send to a specific connection */
  send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg))
  }
}
