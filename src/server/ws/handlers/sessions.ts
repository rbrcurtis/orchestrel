import type { AckResponse } from '../../../shared/ws-protocol';
import type { AppSocket } from '../types';
import { Card } from '../../models/Card';
import { Project } from '../../models/Project';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { busRoomBridge } from '../subscriptions';

export async function handleSessionLoad(
  data: { cardId: number; sessionId?: string },
  callback: (res: AckResponse<{ messages: unknown[] }>) => void,
  socket: AppSocket,
): Promise<void> {
  const { cardId, sessionId } = data;

  try {
    const room = `card:${cardId}`;
    const alreadyJoined = socket.rooms.has(room);
    console.log(
      `[session:load] cardId=${cardId} sessionId=${sessionId ?? 'none'} alreadyJoined=${alreadyJoined}`,
    );

    let messages: unknown[] = [];
    if (sessionId) {
      const card = await Card.findOneBy({ id: cardId });
      let dir = card?.worktreePath ?? undefined;
      if (!dir && card?.projectId) {
        const proj = await Project.findOneBy({ id: card.projectId });
        dir = proj?.path;
      }
      const loaded = await getSessionMessages(sessionId, { dir });
      console.log(`[session:load] cardId=${cardId} loaded ${loaded.length} history messages`);
      messages = loaded as unknown[];
    }

    // Join the card room for live events
    if (!alreadyJoined) {
      socket.join(room);
      busRoomBridge.ensureCardListeners(cardId);
      console.log(`[session:load] cardId=${cardId} joined room ${room}`);
    }

    callback({ data: { messages } });
  } catch (err) {
    console.error(`[session:load] error loading session ${sessionId}:`, err);
    callback({ error: `Failed to load session: ${err}` });
  }
}
