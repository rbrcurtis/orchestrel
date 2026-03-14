import type { WebSocket } from 'ws'
import type { ServerMessage } from '../../shared/ws-protocol'

export class ConnectionManager {
  private connections = new Set<WebSocket>()

  get size() {
    return this.connections.size
  }

  add(ws: WebSocket) {
    this.connections.add(ws)
  }

  remove(ws: WebSocket) {
    this.connections.delete(ws)
  }

  send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg))
  }
}
