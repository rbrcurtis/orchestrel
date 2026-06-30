import type { AckResponse } from '../../../shared/ws-protocol';
import { Card } from '../../models/Card';
import { buildPromptWithFiles } from '../../sessions/manager';
import { trackSession } from '../../controllers/card-sessions';
import { ensureWorktree } from '../../sessions/worktree';
import { isCompactCommand } from '../../../shared/slash-commands';
import { busRoomBridge } from '../subscriptions';

export async function handleAgentSend(
  data: { cardId: number; message: string; files?: Array<{ id: string; name: string; mimeType: string; path: string; size: number }> },
  callback: (res: AckResponse) => void,
  socket: import('../types').AppSocket,
): Promise<void> {
  const { cardId, message, files } = data;
  console.log(`[session:${cardId}] agent:send, len=${message.length}`);

  try {
    callback({});

    // Sending a prompt must also (re)join this socket to the card room. The send
    // path isn't room-gated but the receive path is, so without this a socket
    // that reconnected and lost its room membership would prompt the agent yet
    // never see the streamed reply — the card looks hung.
    busRoomBridge.joinCard(socket, cardId);

    const initState = await import('../../init-state');
    const client = initState.getOrcdClient();
    if (!client) throw new Error('OrcdClient not initialized');

    const card = await Card.findOneByOrFail({ id: cardId });

    // `/compact` typed in the chat box is a Pi TUI command with no meaning on
    // the SDK path. Route it to Pi's full native compaction (NOT the background
    // compactor, which is what the UI context wheel runs). For a live session,
    // forward it as a message so orcd detects + compacts; for an inactive session
    // with history, rehydrate-and-compact directly (orcd can't intercept a
    // message for a session it isn't running).
    if (isCompactCommand(message)) {
      if (card.sessionId && client.isActive(card.sessionId)) {
        trackSession(cardId, card.sessionId);
        client.message(card.sessionId, message);
      } else if (card.sessionId) {
        const cwd = await ensureWorktree(card);
        trackSession(cardId, card.sessionId);
        client.compact({
          sessionId: card.sessionId,
          cwd,
          provider: card.provider,
          model: card.model,
          contextWindow: card.contextWindow,
          summarizeThreshold: card.summarizeThreshold,
          mode: 'full',
        });
      } else {
        console.log(`[session:${cardId}] /compact ignored — no session to compact`);
      }
      return;
    }

    const prompt = buildPromptWithFiles(message, files);

    // Increment prompts sent
    card.promptsSent = (card.promptsSent ?? 0) + 1;

    if (card.sessionId && client.isActive(card.sessionId)) {
      // Follow-up to active session — ensure tracked in router map
      trackSession(cardId, card.sessionId);
      client.message(card.sessionId, prompt);
      // Submitting a prompt should surface the card as running immediately,
      // rather than waiting for the agent's first streamed token (handleTurnStart).
      // Skip archived cards — those were intentionally pulled off the board.
      if (card.column !== 'running' && card.column !== 'archive') {
        card.column = 'running';
      }
      card.updatedAt = new Date().toISOString();
      await card.save();
    } else {
      // New session or resume
      const cwd = await ensureWorktree(card);
      const sessionId = await client.create({
        prompt,
        cwd,
        provider: card.provider,
        model: card.model,
        sessionId: card.sessionId ?? undefined,
        contextWindow: card.contextWindow,
        summarizeThreshold: card.summarizeThreshold,
      });

      card.sessionId = sessionId;
      trackSession(cardId, sessionId);

      if (card.column !== 'running') {
        card.column = 'running';
      }
      card.updatedAt = new Date().toISOString();
      await card.save();
    }
  } catch (err) {
    console.error(`[session:${cardId}] agent:send error:`, err instanceof Error ? err.message : String(err));
  }
}

export async function handleAgentCompact(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId } = data;
  console.log(`[session:${cardId}] agent:compact received`);

  try {
    const initState = await import('../../init-state');
    const client = initState.getOrcdClient();
    if (!client) throw new Error('OrcdClient not initialized');

    const card = await Card.findOneBy({ id: cardId });
    if (!card?.sessionId) {
      callback({ error: 'No session to compact' });
      return;
    }

    const cwd = await ensureWorktree(card);
    trackSession(cardId, card.sessionId);

    // The context wheel button runs Orchestrel's incremental background
    // compaction, distinct from the chat `/compact` command (full Pi compaction).
    callback({});
    client.compact({
      sessionId: card.sessionId,
      cwd,
      provider: card.provider,
      model: card.model,
      contextWindow: card.contextWindow,
      summarizeThreshold: card.summarizeThreshold,
      mode: 'background',
    });
  } catch (err) {
    console.error(`[session:${cardId}] agent:compact error:`, err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleAgentStop(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId } = data;
  console.log(`[session:${cardId}] agent:stop received`);
  callback({});
  const initState = await import('../../init-state');
  const client = initState.getOrcdClient();
  const card = await Card.findOneBy({ id: cardId });
  if (client && card?.sessionId) {
    client.cancel(card.sessionId);
  }
}

export async function handleAgentStatus(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
  socket: import('../types').AppSocket,
): Promise<void> {
  const { cardId } = data;
  try {
    // Status is polled on every SessionView mount and on reconnect, so it's the
    // reliable reconciliation point: rejoin the card room here so a viewed card
    // keeps receiving live events even after a silent socket reconnect.
    busRoomBridge.joinCard(socket, cardId);

    const initState = await import('../../init-state');
    const client = initState.getOrcdClient();
    const card = await Card.findOneBy({ id: cardId });

    const active = !!(card?.sessionId && client?.isActive(card.sessionId));
    const starting = !!card && card.column === 'running' && !card.sessionId;

    if (!active && !starting && card && card.column === 'running') {
      card.column = 'review';
      card.updatedAt = new Date().toISOString();
      await card.save();
    }

    socket.emit('agent:status', {
      cardId,
      active,
      status: active ? 'running' : starting ? 'starting' : 'completed',
      sessionId: card?.sessionId ?? null,
      promptsSent: card?.promptsSent ?? 0,
      turnsCompleted: card?.turnsCompleted ?? 0,
      contextTokens: card?.contextTokens ?? 0,
      contextWindow: card?.contextWindow ?? 200_000,
    });
    callback({});
  } catch (err) {
    console.error(`[session:${cardId}] agent:status error:`, err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
