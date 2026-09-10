import type { AckResponse } from '../../../shared/ws-protocol';
import { resolveWorkDir } from '../../../shared/worktree';
import type { AppSocket } from '../types';
import { busRoomBridge } from '../subscriptions';
import { Card } from '../../models/Card';
import { Project } from '../../models/Project';
import { getPiSessionMessages, getPiSessionHistoryPage } from '../../../lib/pi-session-history';
import { userService } from '../../services/user';
import type { TranscriptHistoryPage, TranscriptHistoryRequest } from '../../../shared/transcript-history';

export async function handleTranscriptSnapshot(
  data: { cardId: number },
  callback: (res: AckResponse<import('../../../shared/orcd-protocol').TranscriptSnapshotMessage['snapshot']>) => void,
  socket: AppSocket,
): Promise<void> {
  try {
    const card = await Card.findOneBy({ id: data.cardId });
    if (!card?.projectId || !card.sessionId) throw new Error('Session not found');
    const identity = socket.data.identity;
    const visible = await userService.visibleProjectIds({ ...identity, role: identity.role === 'admin' ? 'admin' : 'user' });
    if (visible !== 'all' && !visible.includes(card.projectId)) throw new Error('Session not found');
    const { getClientByNode } = await import('../../init-state');
    const client = getClientByNode(card.nodeName);
    if (!client) throw new Error('Node unavailable');
    busRoomBridge.joinCard(socket, card.id);
    client.subscribe(card.sessionId);
    callback({ data: await client.getTranscriptSnapshot(card.sessionId) });
  } catch (err) {
    console.warn('[session:transcript] snapshot failed', err);
    callback({ error: String(err) });
  }
}

export async function handleHistoryPage(
  data: { cardId: number; page: TranscriptHistoryRequest },
  callback: (res: AckResponse<TranscriptHistoryPage>) => void,
  socket: AppSocket,
): Promise<void> {
  try {
    const card = await Card.findOneBy({ id: data.cardId });
    if (!card?.projectId || !card.sessionId) throw new Error('Session not found');
    const identity = socket.data.identity;
    const visible = await userService.visibleProjectIds({ ...identity, role: identity.role === 'admin' ? 'admin' : 'user' });
    if (visible !== 'all' && !visible.includes(card.projectId)) throw new Error('Session not found');
    const project = await Project.findOneBy({ id: card.projectId });
    if (!project) throw new Error('Project not found');
    const cwd = card.sessionCwd ?? resolveWorkDir(card.worktreeBranch, project.path);
    const { getClientByNode } = await import('../../init-state');
    const client = getClientByNode(card.nodeName);
    busRoomBridge.joinCard(socket, card.id);
    if (client?.isActive(card.sessionId)) client.subscribe(card.sessionId);
    const page = card.nodeName === 'local'
      ? await getPiSessionHistoryPage(card.sessionId, cwd, data.page)
      : await client?.getHistoryPage(card.sessionId, cwd, data.page);
    if (!page) throw new Error('Node unavailable');
    callback({ data: page });
  } catch (err) {
    console.warn('[session:history-page] failed', err);
    callback({ error: String(err) });
  }
}

export async function handleSessionLoad(
  data: { cardId: number; sessionId?: string },
  callback: (res: AckResponse<{ messages: unknown[] }>) => void,
  socket: AppSocket,
): Promise<void> {
  const { cardId } = data;

  try {
    const room = `card:${cardId}`;
    const alreadyJoined = socket.rooms.has(room);
    console.log(
      `[session:load] cardId=${cardId} alreadyJoined=${alreadyJoined}`,
    );

    let messages: unknown[] = [];
    const card = await Card.findOneBy({ id: cardId });

    if (card?.sessionId && card.projectId) {
      const proj = await Project.findOneBy({ id: card.projectId });
      if (proj) {
        const cwd = card.sessionCwd ?? resolveWorkDir(card.worktreeBranch, proj.path);
        const initState = await import('../../init-state');
        const client = initState.getClientByNode(card.nodeName);

        if (client && card.nodeName !== 'local') {
          // Remote node: fetch history over the wire
          try {
            messages = await client.getHistory(card.sessionId, cwd);
          } catch (err) {
            console.error(`[session:load] remote history fetch failed:`, err);
          }
        } else {
          // Local node: read session files directly
          messages = await getPiSessionMessages(card.sessionId, cwd);
        }
        console.log(`[session:load] cardId=${cardId} loaded ${messages.length} messages`);
      }
    }

    // Join the card room for live events (idempotent)
    busRoomBridge.joinCard(socket, cardId);
    if (!alreadyJoined) console.log(`[session:load] cardId=${cardId} joined room ${room}`);

    // Subscribe to orcd for live events (if session is active)
    if (card?.sessionId) {
      const initState = await import('../../init-state');
      const client = initState.getClientByNode(card.nodeName);
      if (client?.isActive(card.sessionId)) {
        client.subscribe(card.sessionId);
      }
    }

    callback({ data: { messages } });
  } catch (err) {
    console.error(`[session:load] error loading session:`, err);
    callback({ error: `Failed to load session: ${err}` });
  }
}
