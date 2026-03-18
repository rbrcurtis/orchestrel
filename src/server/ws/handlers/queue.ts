import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import { Card } from '../../models/Card'

export async function handleQueueReorder(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'queue:reorder' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, cardId, newPosition } = msg
  try {
    const card = await Card.findOneBy({ id: cardId })
    if (!card || card.queuePosition == null) {
      connections.send(ws, { type: 'mutation:error', requestId, error: 'Card is not queued' })
      return
    }
    if (!card.projectId) {
      connections.send(ws, { type: 'mutation:error', requestId, error: 'Card has no project' })
      return
    }

    const oldPosition = card.queuePosition

    const queued = await Card.find({
      where: {
        column: 'running',
        projectId: card.projectId,
        useWorktree: false as unknown as boolean,
      },
    })
    const queuedOnly = queued.filter(c => c.queuePosition != null)

    if (newPosition < 1 || newPosition > queuedOnly.length) {
      connections.send(ws, { type: 'mutation:error', requestId, error: `Position must be between 1 and ${queuedOnly.length}` })
      return
    }

    if (newPosition === oldPosition) {
      connections.send(ws, { type: 'mutation:ok', requestId })
      return
    }

    for (const c of queuedOnly) {
      if (c.id === cardId) continue
      if (c.queuePosition == null) continue

      if (newPosition < oldPosition) {
        if (c.queuePosition >= newPosition && c.queuePosition < oldPosition) {
          c.queuePosition += 1
          c.updatedAt = new Date().toISOString()
          await c.save()
        }
      } else {
        if (c.queuePosition > oldPosition && c.queuePosition <= newPosition) {
          c.queuePosition -= 1
          c.updatedAt = new Date().toISOString()
          await c.save()
        }
      }
    }

    card.queuePosition = newPosition
    card.updatedAt = new Date().toISOString()
    await card.save()

    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}
