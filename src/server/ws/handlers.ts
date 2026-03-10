import type { WebSocket } from 'ws'
import type { ConnectionManager } from './connections'
import type { DbMutator } from '../db/mutator'
import { clientMessage } from '../../shared/ws-protocol'
import { db } from '../db/index'
import { cards } from '../db/schema'
import { like, or, asc, count } from 'drizzle-orm'
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
import {
  handleClaudeStart,
  handleClaudeSend,
  handleClaudeStop,
  handleClaudeStatus,
} from './handlers/claude'

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
      requestId: (raw as Record<string, unknown>)?.requestId as string ?? 'unknown',
      error: `Invalid message: ${parsed.error.message}`,
    })
    return
  }

  const msg = parsed.data

  switch (msg.type) {
    case 'subscribe': {
      connections.subscribe(ws, msg.columns)
      const syncCards = mutator.listCards(msg.columns.length > 0 ? msg.columns : undefined)
      const syncProjects = mutator.listProjects()
      connections.send(ws, { type: 'sync', cards: syncCards, projects: syncProjects })
      break
    }

    case 'page': {
      const { column, cursor, limit } = msg
      const allCards = mutator.listCards([column])
      const sorted = allCards.sort((a, b) => a.position - b.position)
      const startIdx = cursor !== undefined
        ? sorted.findIndex(c => c.id === cursor) + 1
        : 0
      const pageSize = limit ?? PAGE_SIZE
      const slice = sorted.slice(startIdx, startIdx + pageSize)
      const nextCursor = startIdx + pageSize < sorted.length
        ? slice[slice.length - 1]?.id
        : undefined
      connections.send(ws, {
        type: 'page:result',
        column,
        cards: slice,
        nextCursor,
        total: sorted.length,
      })
      break
    }

    case 'search': {
      const { query, requestId } = msg
      const pattern = `%${query}%`
      const results = db
        .select()
        .from(cards)
        .where(or(like(cards.title, pattern), like(cards.description, pattern)))
        .orderBy(asc(cards.position))
        .all()
      const [{ value: total }] = db
        .select({ value: count() })
        .from(cards)
        .where(or(like(cards.title, pattern), like(cards.description, pattern)))
        .all()
      connections.send(ws, {
        type: 'search:result',
        requestId,
        cards: results,
        total,
      })
      break
    }

    case 'card:create':
      void handleCardCreate(ws, msg, connections, mutator)
      break

    case 'card:update':
      void handleCardUpdate(ws, msg, connections, mutator)
      break

    case 'card:move':
      void handleCardMove(ws, msg, connections, mutator)
      break

    case 'card:delete':
      handleCardDelete(ws, msg, connections, mutator)
      break

    case 'card:generateTitle':
      void handleCardGenerateTitle(ws, msg, connections, mutator)
      break

    case 'project:create':
      void handleProjectCreate(ws, msg, connections, mutator)
      break

    case 'project:update':
      void handleProjectUpdate(ws, msg, connections, mutator)
      break

    case 'project:delete':
      handleProjectDelete(ws, msg, connections, mutator)
      break

    case 'project:browse':
      void handleProjectBrowse(ws, msg, connections)
      break

    case 'session:load':
      void handleSessionLoad(ws, msg, connections)
      break

    case 'claude:start':
      void handleClaudeStart(ws, msg, connections, mutator)
      break

    case 'claude:send':
      void handleClaudeSend(ws, msg, connections, mutator)
      break

    case 'claude:stop':
      void handleClaudeStop(ws, msg, connections, mutator)
      break

    case 'claude:status':
      void handleClaudeStatus(ws, msg, connections, mutator)
      break

    default: {
      const exhausted = msg as { type: string; requestId?: string }
      connections.send(ws, {
        type: 'mutation:error',
        requestId: exhausted.requestId ?? 'unknown',
        error: `Handler not implemented: ${exhausted.type}`,
      })
    }
  }
}
