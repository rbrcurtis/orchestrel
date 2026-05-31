import type { AckResponse } from '../../../shared/ws-protocol';
import type { AppSocket } from '../types';
import { busRoomBridge } from '../subscriptions';
import { Card } from '../../models/Card';
import { Project } from '../../models/Project';
import { resolveWorkDir } from '../../../shared/worktree';
import { getPiSessionMessages } from '../../../lib/pi-session-history';

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
        const cwd = resolveWorkDir(card.worktreeBranch ?? null, proj.path);
        messages = await getPiSessionMessages(card.sessionId, cwd);
        console.log(`[session:load] cardId=${cardId} loaded ${messages.length} messages from Pi session history`);
      }
    }

    // Join the card room for live events
    if (!alreadyJoined) {
      socket.join(room);
      busRoomBridge.ensureCardListeners(cardId);
      console.log(`[session:load] cardId=${cardId} joined room ${room}`);
    }

    // Subscribe to orcd for live events (if session is active)
    if (card?.sessionId) {
      const initState = await import('../../init-state');
      const client = initState.getOrcdClient();
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
