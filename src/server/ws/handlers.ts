import type { WebSocket } from 'ws';
import type { ConnectionManager } from './connections';
import { clientSubs } from './subscriptions';
import { clientMessage } from '../../shared/ws-protocol';
import { cardService } from '../services/card';
import { projectService } from '../services/project';
import { getProvidersForClient } from '../config/providers';
import {
  handleCardCreate,
  handleCardUpdate,
  handleCardDelete,
  handleCardGenerateTitle,
  handleCardSuggestTitle,
} from './handlers/cards';
import {
  handleProjectCreate,
  handleProjectUpdate,
  handleProjectDelete,
  handleProjectBrowse,
  handleProjectMkdir,
} from './handlers/projects';
import { handleSessionLoad } from './handlers/sessions';
import { handleAgentSend, handleAgentCompact, handleAgentStop, handleAgentStatus } from './handlers/agents';
import { handleQueueReorder } from './handlers/queue';
import type { Card, Project } from '../../shared/ws-protocol';
import type { Card as CardEntity } from '../models/Card';

export function handleMessage(ws: WebSocket, raw: unknown, connections: ConnectionManager) {
  const parsed = clientMessage.safeParse(raw);
  if (!parsed.success) {
    connections.send(ws, {
      type: 'mutation:error',
      requestId: ((raw as Record<string, unknown>)?.requestId as string) ?? 'unknown',
      error: `Invalid message: ${parsed.error.message}`,
    });
    return;
  }

  const msg = parsed.data;
  const rid = 'requestId' in msg ? (msg as { requestId?: string }).requestId : undefined;
  if (rid) console.log(`[ws] → ${msg.type} requestId=${rid}`);

  switch (msg.type) {
    case 'subscribe': {
      const cols = msg.columns;

      // Send initial sync — scoped by user visibility
      void (async () => {
        try {
          const identity = connections.getIdentity(ws);
          if (!identity) return;

          const { userService } = await import('../services/user');
          const visible = await userService.visibleProjectIds(identity);

          const [allCards, allProjects] = await Promise.all([
            cardService.listCards(cols.length > 0 ? cols : undefined),
            projectService.listProjects(),
          ]);

          const cards = visible === 'all'
            ? allCards
            : allCards.filter((c) => c.projectId != null && (visible as number[]).includes(c.projectId));
          const projects = visible === 'all'
            ? allProjects
            : allProjects.filter((p) => (visible as number[]).includes(p.id));

          let users: Array<{ id: number; email: string; role: string }> | undefined;
          if (identity.role === 'admin') {
            users = await userService.listUsers();
            for (const p of projects) {
              (p as unknown as Record<string, unknown>).userIds = await userService.projectUserIds(p.id);
            }
          }

          connections.send(ws, {
            type: 'sync',
            cards: cards as unknown as Card[],
            projects: projects as unknown as Project[],
            providers: getProvidersForClient(),
            user: { id: identity.id, email: identity.email, role: identity.role },
            users,
          });
        } catch (err) {
          console.error('[ws] subscribe sync error:', err);
        }
      })();

      // Subscribe to board:changed — forward card:updated or card:deleted
      clientSubs.subscribe(ws, 'board:changed', (payload) => {
        const { card, oldColumn, newColumn, id } = payload as {
          card: CardEntity | null;
          oldColumn: string | null;
          newColumn: string | null;
          id?: number;
        };
        if (!card) {
          if (id) connections.send(ws, { type: 'card:deleted', data: { id } });
          return;
        }
        const relevant =
          cols.length === 0 ||
          (oldColumn && cols.includes(oldColumn as never)) ||
          (newColumn && cols.includes(newColumn as never));
        if (relevant) {
          connections.send(ws, { type: 'card:updated', data: card as Card });
        }
      });

      // Subscribe to project updates for all known projects
      projectService
        .listProjects()
        .then((projs) => {
          for (const p of projs) {
            clientSubs.subscribe(ws, `project:${p.id}:updated`, (payload) => {
              connections.send(ws, {
                type: 'project:updated',
                data: payload as import('../../shared/ws-protocol').Project,
              });
            });
            clientSubs.subscribe(ws, `project:${p.id}:deleted`, (payload) => {
              connections.send(ws, { type: 'project:deleted', data: payload as { id: number } });
            });
          }
        })
        .catch((err) => console.error('[ws] subscribe project listing error:', err));

      // Subscribe to system errors — forward to all subscribed clients
      clientSubs.subscribe(ws, 'system:error', (payload) => {
        const { message } = payload as { message: string };
        connections.send(ws, {
          type: 'session:message',
          cardId: -1,
          message: {
            type: 'error',
            message,
            timestamp: Date.now(),
          },
        });
      });

      break;
    }

    case 'page': {
      const { column, cursor, limit } = msg;
      cardService
        .pageCards(column, cursor, limit)
        .then((result) => {
          connections.send(ws, {
            type: 'page:result',
            column,
            cards: result.cards as Card[],
            nextCursor: result.nextCursor,
            total: result.total,
          });
        })
        .catch((err) => console.error('[ws] page error:', err));
      break;
    }

    case 'search': {
      const { query, requestId } = msg;
      cardService
        .searchCards(query)
        .then(({ cards, total }) => {
          connections.send(ws, { type: 'search:result', requestId, cards: cards as Card[], total });
        })
        .catch((err) => console.error('[ws] search error:', err));
      break;
    }

    case 'card:create':
      void handleCardCreate(ws, msg, connections);
      break;

    case 'card:update':
      void handleCardUpdate(ws, msg, connections);
      break;

    case 'card:delete':
      handleCardDelete(ws, msg, connections);
      break;

    case 'card:generateTitle':
      void handleCardGenerateTitle(ws, msg, connections);
      break;

    case 'card:suggestTitle':
      void handleCardSuggestTitle(ws, msg, connections);
      break;

    case 'project:create':
      void handleProjectCreate(ws, msg, connections);
      break;

    case 'project:update':
      void handleProjectUpdate(ws, msg, connections);
      break;

    case 'project:delete':
      handleProjectDelete(ws, msg, connections);
      break;

    case 'project:browse':
      void handleProjectBrowse(ws, msg, connections);
      break;

    case 'project:mkdir':
      void handleProjectMkdir(ws, msg, connections);
      break;

    case 'session:load':
      void handleSessionLoad(ws, msg, connections);
      break;

    case 'agent:send':
      void handleAgentSend(ws, msg, connections);
      break;

    case 'agent:compact':
      void handleAgentCompact(ws, msg, connections);
      break;

    case 'agent:stop':
      void handleAgentStop(ws, msg, connections);
      break;

    case 'agent:status':
      void handleAgentStatus(ws, msg, connections);
      break;

    case 'session:set-model': {
      const { cardId, provider, model } = msg.data;
      void (async () => {
        try {
          const initState = await import('../init-state');
          const sm = initState.getSessionManager();
          sm?.setModel(cardId, provider, model);
          const { Card } = await import('../models/Card');
          const card = await Card.findOneBy({ id: cardId });
          if (card) {
            card.provider = provider;
            card.model = model;
            card.updatedAt = new Date().toISOString();
            await card.save();
          }
          connections.send(ws, { type: 'mutation:ok', requestId: msg.requestId });
        } catch (err) {
          connections.send(ws, {
            type: 'mutation:error',
            requestId: msg.requestId,
            error: String(err instanceof Error ? err.message : err),
          });
        }
      })();
      break;
    }

    case 'queue:reorder':
      void handleQueueReorder(ws, msg, connections);
      break;

    default: {
      const exhausted = msg as { type: string; requestId?: string };
      connections.send(ws, {
        type: 'mutation:error',
        requestId: exhausted.requestId ?? 'unknown',
        error: `Handler not implemented: ${exhausted.type}`,
      });
    }
  }
}
