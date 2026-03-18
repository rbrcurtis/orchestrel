import type { WebSocket } from 'ws'
import type { ConnectionManager } from './connections'
import { clientSubs } from './subscriptions'
import { clientMessage } from '../../shared/ws-protocol'
import { cardService } from '../services/card'
import { projectService } from '../services/project'
import {
  handleCardCreate,
  handleCardUpdate,
  handleCardDelete,
  handleCardGenerateTitle,
  handleCardSuggestTitle,
} from './handlers/cards'
import {
  handleProjectCreate,
  handleProjectUpdate,
  handleProjectDelete,
  handleProjectBrowse,
  handleProjectMkdir,
} from './handlers/projects'
import { handleSessionLoad } from './handlers/sessions'
import {
  handleAgentSend,
  handleAgentStop,
  handleAgentStatus,
} from './handlers/agents'
import { handleQueueReorder } from './handlers/queue'
import type { Card, Project } from '../../shared/ws-protocol'
import type { Card as CardEntity } from '../models/Card'

export function handleMessage(
  ws: WebSocket,
  raw: unknown,
  connections: ConnectionManager,
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
  const rid = 'requestId' in msg ? (msg as { requestId?: string }).requestId : undefined
  if (rid) console.log(`[ws] → ${msg.type} requestId=${rid}`)

  switch (msg.type) {
    case 'subscribe': {
      const cols = msg.columns

      // Send initial sync
      Promise.all([
        cardService.listCards(cols.length > 0 ? cols : undefined),
        projectService.listProjects(),
      ]).then(([syncCards, syncProjects]) => {
        connections.send(ws, { type: 'sync', cards: syncCards as unknown as Card[], projects: syncProjects as unknown as Project[] })
      }).catch(err => console.error('[ws] subscribe sync error:', err))

      // Subscribe to board:changed — forward card:updated or card:deleted
      clientSubs.subscribe(ws, 'board:changed', (payload) => {
        const { card, oldColumn, newColumn, id } = payload as { card: CardEntity | null; oldColumn: string | null; newColumn: string | null; id?: number }
        if (!card) {
          if (id) connections.send(ws, { type: 'card:deleted', data: { id } })
          return
        }
        const relevant = cols.length === 0 ||
          (oldColumn && cols.includes(oldColumn as never)) ||
          (newColumn && cols.includes(newColumn as never))
        if (relevant) {
          connections.send(ws, { type: 'card:updated', data: card as Card })
        }
      })

      // Subscribe to project updates for all known projects
      projectService.listProjects().then(projs => {
        for (const p of projs) {
          clientSubs.subscribe(ws, `project:${p.id}:updated`, (payload) => {
            connections.send(ws, { type: 'project:updated', data: payload as import('../../shared/ws-protocol').Project })
          })
          clientSubs.subscribe(ws, `project:${p.id}:deleted`, (payload) => {
            connections.send(ws, { type: 'project:deleted', data: payload as { id: number } })
          })
        }
      }).catch(err => console.error('[ws] subscribe project listing error:', err))

      // Subscribe to system errors — forward to all subscribed clients
      clientSubs.subscribe(ws, 'system:error', (payload) => {
        const { message } = payload as { message: string }
        connections.send(ws, {
          type: 'agent:message',
          cardId: -1,
          data: {
            type: 'error',
            role: 'system',
            content: message,
            timestamp: Date.now(),
          },
        })
      })

      break
    }

    case 'page': {
      const { column, cursor, limit } = msg
      cardService.pageCards(column, cursor, limit).then(result => {
        connections.send(ws, {
          type: 'page:result',
          column,
          cards: result.cards as Card[],
          nextCursor: result.nextCursor,
          total: result.total,
        })
      }).catch(err => console.error('[ws] page error:', err))
      break
    }

    case 'search': {
      const { query, requestId } = msg
      cardService.searchCards(query).then(({ cards, total }) => {
        connections.send(ws, { type: 'search:result', requestId, cards: cards as Card[], total })
      }).catch(err => console.error('[ws] search error:', err))
      break
    }

    case 'card:create':
      void handleCardCreate(ws, msg, connections)
      break

    case 'card:update':
      void handleCardUpdate(ws, msg, connections)
      break

    case 'card:delete':
      handleCardDelete(ws, msg, connections)
      break

    case 'card:generateTitle':
      void handleCardGenerateTitle(ws, msg, connections)
      break

    case 'card:suggestTitle':
      void handleCardSuggestTitle(ws, msg, connections)
      break

    case 'project:create':
      void handleProjectCreate(ws, msg, connections)
      break

    case 'project:update':
      void handleProjectUpdate(ws, msg, connections)
      break

    case 'project:delete':
      handleProjectDelete(ws, msg, connections)
      break

    case 'project:browse':
      void handleProjectBrowse(ws, msg, connections)
      break

    case 'project:mkdir':
      void handleProjectMkdir(ws, msg, connections)
      break

    case 'session:load':
      void handleSessionLoad(ws, msg, connections)
      break

    case 'agent:send':
      void handleAgentSend(ws, msg, connections)
      break

    case 'agent:stop':
      void handleAgentStop(ws, msg, connections)
      break

    case 'agent:status':
      void handleAgentStatus(ws, msg, connections)
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
