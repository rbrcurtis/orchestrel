import type { AppSocket, AppServer } from './types';
import { busRoomBridge } from './subscriptions';
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
import type { Card, Column, Project } from '../../shared/ws-protocol';

export function registerSocketEvents(socket: AppSocket, io: AppServer): void {
  const identity = socket.data.identity;
  console.log(`[ws] connection: ${identity.email} (${identity.role})`);

  // ── Subscribe ────────────────────────────────────────────────────────────
  socket.on('subscribe', async (columns, callback) => {
    try {
      // Leave old column rooms, join new ones
      for (const room of socket.rooms) {
        if (room.startsWith('col:')) socket.leave(room);
      }
      for (const col of columns) socket.join(`col:${col}`);

      // Build sync payload scoped by user visibility
      const { userService } = await import('../services/user');
      const visible = await userService.visibleProjectIds(identity as import('../services/user').UserIdentity);

      const [allCards, allProjects] = await Promise.all([
        cardService.listCards(columns.length > 0 ? columns as Column[] : undefined),
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

      callback({
        data: {
          cards: cards as unknown as Card[],
          projects: projects as unknown as Project[],
          providers: getProvidersForClient(),
          user: { id: identity.id, email: identity.email, role: identity.role },
          users,
        },
      });
    } catch (err) {
      console.error('[ws] subscribe error:', err);
      callback({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Page ─────────────────────────────────────────────────────────────────
  socket.on('page', async (data, callback) => {
    try {
      const result = await cardService.pageCards(data.column as Column, data.cursor, data.limit);
      callback({
        data: {
          column: data.column as Column,
          cards: result.cards as unknown as Card[],
          nextCursor: result.nextCursor,
          total: result.total,
        },
      });
    } catch (err) {
      console.error('[ws] page error:', err);
      callback({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Search ───────────────────────────────────────────────────────────────
  socket.on('search', async (data, callback) => {
    try {
      const { cards, total } = await cardService.searchCards(data.query);
      callback({ data: { cards: cards as unknown as Card[], total } });
    } catch (err) {
      console.error('[ws] search error:', err);
      callback({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Card CRUD ────────────────────────────────────────────────────────────
  socket.on('card:create', (data, cb) => void handleCardCreate(data, cb));
  socket.on('card:update', (data, cb) => void handleCardUpdate(data, cb));
  socket.on('card:delete', (data, cb) => void handleCardDelete(data, cb));
  socket.on('card:generateTitle', (data, cb) => void handleCardGenerateTitle(data, cb));
  socket.on('card:suggestTitle', (data, cb) => void handleCardSuggestTitle(data, cb));

  // ── Project CRUD ─────────────────────────────────────────────────────────
  socket.on('project:create', (data, cb) => void handleProjectCreate(data, cb));
  socket.on('project:update', (data, cb) => void handleProjectUpdate(data, cb, socket, io));
  socket.on('project:delete', (data, cb) => void handleProjectDelete(data, cb));
  socket.on('project:browse', (data, cb) => void handleProjectBrowse(data, cb));
  socket.on('project:mkdir', (data, cb) => void handleProjectMkdir(data, cb));

  // ── Agent ────────────────────────────────────────────────────────────────
  socket.on('agent:send', (data, cb) => void handleAgentSend(data, cb));
  socket.on('agent:compact', (data, cb) => void handleAgentCompact(data, cb));
  socket.on('agent:stop', (data, cb) => void handleAgentStop(data, cb));
  socket.on('agent:status', (data, cb) => void handleAgentStatus(data, cb, socket));

  // ── Session ──────────────────────────────────────────────────────────────
  socket.on('session:load', (data, cb) => void handleSessionLoad(data, cb, socket));

  socket.on('session:set-model', async (data, callback) => {
    const { cardId, provider, model } = data;
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
      callback({});
    } catch (err) {
      callback({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Queue ────────────────────────────────────────────────────────────────
  socket.on('queue:reorder', (data, cb) => void handleQueueReorder(data, cb));

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[ws] disconnect: ${identity.email}`);
    // Clean up card room bus listeners if rooms are now empty
    for (const room of socket.rooms) {
      const match = room.match(/^card:(\d+)$/);
      if (match) {
        busRoomBridge.cleanupCardIfEmpty(Number(match[1]));
      }
    }
  });
}
