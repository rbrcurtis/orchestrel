import type { WebSocket } from 'ws'
import type { ConnectionManager } from './connections'
import type { DbMutator } from '../db/mutator'
import { clientMessage } from '../../shared/ws-protocol'

export function handleMessage(
  ws: WebSocket,
  raw: unknown,
  connections: ConnectionManager,
  mutator: DbMutator,
) {
  const parsed = clientMessage.safeParse(raw)
  if (!parsed.success) {
    connections.send(ws, {
      type: 'mutation:error',
      requestId: (raw as Record<string, unknown>)?.requestId as string ?? 'unknown',
      error: `Invalid message: ${parsed.error.message}`,
    })
    return
  }

  const msg = parsed.data
  switch (msg.type) {
    case 'subscribe': {
      connections.subscribe(ws, msg.columns)
      // Send sync with cards in subscribed columns + all projects
      const syncCards = mutator.listCards(msg.columns as Parameters<typeof mutator.listCards>[0])
      const syncProjects = mutator.listProjects()
      connections.send(ws, { type: 'sync', cards: syncCards, projects: syncProjects })
      break
    }
    default:
      // TODO: implement remaining handlers in Task 3
      if ('requestId' in msg) {
        connections.send(ws, {
          type: 'mutation:error',
          requestId: msg.requestId,
          error: `Handler not implemented: ${msg.type}`,
        })
      }
  }
}
