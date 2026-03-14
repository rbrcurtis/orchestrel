import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import { sessionService } from '../../services/session'
import { Card } from '../../models/Card'

export async function handleAgentSend(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:send' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data: { cardId, message, files } } = msg
  console.log(`[session:${cardId}] agent:send received, message length=${message.length}, files=${files?.length ?? 0}`)

  try {
    // Respond immediately — startSession runs in background
    connections.send(ws, { type: 'mutation:ok', requestId })

    sessionService.startSession(cardId, message, files).catch((err) => {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[session:${cardId}] startSession error:`, error)
      connections.send(ws, {
        type: 'agent:status',
        data: {
          cardId,
          active: false,
          status: 'errored',
          sessionId: null,
          promptsSent: 0,
          turnsCompleted: 0,
        },
      })
    })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}

export async function handleAgentStop(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:stop' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data: { cardId } } = msg
  console.log(`[session:${cardId}] agent:stop received`)
  try {
    await sessionService.stopSession(cardId)
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}

export async function handleAgentStatus(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:status' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data: { cardId } } = msg
  try {
    const live = sessionService.getStatus(cardId)
    if (live) {
      connections.send(ws, { type: 'agent:status', data: live })
    } else {
      // No active session — read counters from DB via model
      const card = await Card.findOneBy({ id: cardId })
      connections.send(ws, {
        type: 'agent:status',
        data: {
          cardId,
          active: false,
          status: 'completed',
          sessionId: card?.sessionId ?? null,
          promptsSent: card?.promptsSent ?? 0,
          turnsCompleted: card?.turnsCompleted ?? 0,
        },
      })
    }
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}
