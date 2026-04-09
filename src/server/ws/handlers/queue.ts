import type { AckResponse } from '../../../shared/ws-protocol';
import { Card } from '../../models/Card';

export async function handleQueueReorder(
  data: { cardId: number; newPosition: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId, newPosition } = data;
  try {
    const card = await Card.findOneBy({ id: cardId });
    if (!card || card.queuePosition == null) {
      callback({ error: 'Card is not queued' });
      return;
    }
    if (!card.projectId) {
      callback({ error: 'Card has no project' });
      return;
    }

    const oldPosition = card.queuePosition;

    const queued = await Card.find({
      where: {
        column: 'running',
        projectId: card.projectId,
        useWorktree: false as unknown as boolean,
      },
    });
    const queuedOnly = queued.filter(c => c.queuePosition != null);

    if (newPosition < 1 || newPosition > queuedOnly.length) {
      callback({ error: `Position must be between 1 and ${queuedOnly.length}` });
      return;
    }

    if (newPosition === oldPosition) {
      callback({});
      return;
    }

    for (const c of queuedOnly) {
      if (c.id === cardId) continue;
      if (c.queuePosition == null) continue;

      if (newPosition < oldPosition) {
        if (c.queuePosition >= newPosition && c.queuePosition < oldPosition) {
          c.queuePosition += 1;
          c.updatedAt = new Date().toISOString();
          await c.save();
        }
      } else {
        if (c.queuePosition > oldPosition && c.queuePosition <= newPosition) {
          c.queuePosition -= 1;
          c.updatedAt = new Date().toISOString();
          await c.save();
        }
      }
    }

    card.queuePosition = newPosition;
    card.updatedAt = new Date().toISOString();
    await card.save();

    callback({});
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
