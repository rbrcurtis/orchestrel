import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import { cardService } from '../../services/card'

export async function handleCardCreate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:create' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data } = msg
  try {
    const card = await cardService.createCard(data)
    connections.send(ws, { type: 'mutation:ok', requestId, data: card })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}

export async function handleCardUpdate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:update' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data } = msg
  const { id, ...rest } = data
  try {
    const card = await cardService.updateCard(id, rest)
    connections.send(ws, { type: 'mutation:ok', requestId, data: card })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}

export function handleCardDelete(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:delete' }>,
  connections: ConnectionManager,
): void {
  const { requestId, data } = msg
  cardService.deleteCard(data.id)
    .then(() => connections.send(ws, { type: 'mutation:ok', requestId }))
    .catch(err => connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) }))
}

export async function handleCardGenerateTitle(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:generateTitle' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data } = msg
  try {
    const card = await cardService.generateTitle(data.id)
    connections.send(ws, { type: 'mutation:ok', requestId, data: card })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}

export async function handleCardSuggestTitle(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'card:suggestTitle' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data } = msg
  try {
    const title = await cardService.suggestTitle(data.description)
    connections.send(ws, { type: 'mutation:ok', requestId, data: title })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}
