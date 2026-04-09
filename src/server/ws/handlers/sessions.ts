import type { AckResponse } from '../../../shared/ws-protocol';
import type { AppSocket } from '../types';
import { getMessages } from '../../sessions/conversation-store';
import { busRoomBridge } from '../subscriptions';

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

    const messages = getMessages(cardId) as unknown[];

    // Join the card room for live events
    if (!alreadyJoined) {
      socket.join(room);
      busRoomBridge.ensureCardListeners(cardId);
      console.log(`[session:load] cardId=${cardId} joined room ${room}`);
    }

    callback({ data: { messages } });
  } catch (err) {
    console.error(`[session:load] error loading session:`, err);
    callback({ error: `Failed to load session: ${err}` });
  }
}
