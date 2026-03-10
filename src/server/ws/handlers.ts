import type { WebSocket } from 'ws'
import type { ConnectionManager } from './connections'
import type { DbMutator } from '../db/mutator'
import { clientMessage } from '../../shared/ws-protocol'
import { db } from '../db/index'
import { cards } from '../db/schema'
import { like, or, asc } from 'drizzle-orm'
import {
  handleCardCreate,
  handleCardUpdate,
  handleCardMove,
  handleCardDelete,
  handleCardGenerateTitle,
} from './handlers/cards'
import {
  handleProjectCreate,
  handleProjectUpdate,
  handleProjectDelete,
  handleProjectBrowse,
} from './handlers/projects'
import { handleSessionLoad } from './handlers/sessions'

const PAGE_SIZE = 20

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
      data: {
        requestId: (raw as Record<string, unknown>)?.requestId as string ?? 'unknown',
        error: `Invalid message: ${parsed.error.message}`,
      },
    })
    return
  }

  const msg = parsed.data
  const requestId = 'requestId' in msg.data
    ? (msg.data as Record<string, unknown>).requestId as string
    : msg.type

  switch (msg.type) {
    case 'subscribe': {
      const cols = msg.data.column ? [msg.data.column] : []
      connections.subscribe(ws, cols)
      const syncCards = mutator.listCards(cols.length > 0 ? cols : undefined)
      const syncProjects = mutator.listProjects()
      connections.send(ws, { type: 'sync', data: { cards: syncCards, projects: syncProjects } })
      break
    }

    case 'page': {
      const { column, cursor } = msg.data
      const allCards = mutator.listCards([column])
      const sorted = allCards.sort((a, b) => a.position - b.position)
      const startIdx = cursor !== undefined
        ? sorted.findIndex(c => c.id === cursor) + 1
        : 0
      const slice = sorted.slice(startIdx, startIdx + PAGE_SIZE)
      const hasMore = startIdx + PAGE_SIZE < sorted.length
      connections.send(ws, {
        type: 'page:result',
        data: { requestId: column, column, cards: slice, hasMore },
      })
      break
    }

    case 'search': {
      const { query, requestId: searchReqId } = msg.data
      const pattern = `%${query}%`
      const results = db
        .select()
        .from(cards)
        .where(or(like(cards.title, pattern), like(cards.description, pattern)))
        .orderBy(asc(cards.position))
        .all()
      connections.send(ws, {
        type: 'search:result',
        data: { requestId: searchReqId, cards: results },
      })
      break
    }

    case 'card:create':
      void handleCardCreate(ws, msg, connections, mutator, requestId)
      break

    case 'card:update':
      void handleCardUpdate(ws, msg, connections, mutator, requestId)
      break

    case 'card:move':
      void handleCardMove(ws, msg, connections, mutator, requestId)
      break

    case 'card:delete':
      handleCardDelete(ws, msg, connections, mutator, requestId)
      break

    case 'card:generateTitle':
      void handleCardGenerateTitle(ws, msg, connections, mutator, requestId)
      break

    case 'project:create':
      void handleProjectCreate(ws, msg, connections, mutator, requestId)
      break

    case 'project:update':
      void handleProjectUpdate(ws, msg, connections, mutator, requestId)
      break

    case 'project:delete':
      handleProjectDelete(ws, msg, connections, mutator, requestId)
      break

    case 'project:browse':
      void handleProjectBrowse(ws, msg, connections)
      break

    case 'session:load':
      void handleSessionLoad(ws, msg, connections)
      break

    default:
      // Claude messages handled elsewhere (claude:start, claude:send, claude:stop, claude:status)
      connections.send(ws, {
        type: 'mutation:error',
        data: {
          requestId,
          error: `Handler not implemented: ${(msg as { type: string }).type}`,
        },
      })
  }
}
