import type { AckResponse } from '../../../shared/ws-protocol';
import { Card } from '../../models/Card';
import { buildPromptWithFiles } from '../../sessions/manager';
import { trackSession, markCreatePending, clearCreatePending, isCreatePending } from '../../controllers/card-sessions';
import { ensureWorktree } from '../../sessions/worktree';
import { isCompactCommand } from '../../../shared/slash-commands';
import { busRoomBridge } from '../subscriptions';
import { windowForCard } from '../../config/capabilities';

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

    const card = await Card.findOneByOrFail({ id: cardId });
    const initState = await import('../../init-state');
    const client = initState.getClientByNode(card.nodeName);
    if (!client) throw new Error(`node ${card.nodeName} has no client`);

    // `/compact` typed in the chat box is a Pi TUI command with no meaning on
    // the SDK path. Route it to Pi's full native compaction (same as the UI
    // context wheel). For a live session,
    // forward it as a message so orcd detects + compacts; for an inactive session
    // with history, rehydrate-and-compact directly (orcd can't intercept a
    // message for a session it isn't running).
    if (isCompactCommand(message)) {
      if (card.sessionId && client.isActive(card.sessionId)) {
        trackSession(cardId, card.sessionId);
        client.message(card.sessionId, message);
      } else if (card.sessionId) {
        const cwd = await ensureWorktree(card, client);
        trackSession(cardId, card.sessionId);
        client.compact({
          sessionId: card.sessionId,
          cwd,
          provider: card.provider,
          model: card.model,
          contextWindow: windowForCard(card),
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
      // New session or resume. Move the card to running BEFORE the worktree +
      // orcd create roundtrip so the board reacts instantly; the session just
      // isn't active yet. markCreatePending tells the board:changed auto-start
      // and agent:status reconciliation that the missing session is expected.
      const prevColumn = card.column;
      markCreatePending(cardId);
      try {
        if (card.column !== 'running') {
          card.column = 'running';
          card.updatedAt = new Date().toISOString();
          await card.save();
        }

        const cwd = await ensureWorktree(card, client);
        const effort = card.thinkingLevel === 'off' ? 'disabled' : card.thinkingLevel;
        // Node is connected here, so windowForCard resolves the live window. Heal
        // the persisted cache back to the DB (it drifts to 200k when a card is
        // created while the node's capabilities aren't yet available).
        const window = windowForCard(card);
        const sessionId = await client.create({
          prompt,
          cwd,
          provider: card.provider,
          model: card.model,
          sessionId: card.sessionId ?? undefined,
          contextWindow: window,
          summarizeThreshold: card.summarizeThreshold,
          effort,
        });

        card.sessionId = sessionId;
        card.contextWindow = window;
        trackSession(cardId, sessionId);

        card.updatedAt = new Date().toISOString();
        await card.save();
      } catch (err) {
        console.error(`[session:${cardId}] session create failed:`, err instanceof Error ? err.message : String(err));
        // Create failed — put the card back where it was so it isn't stranded
        // in running with no session behind it.
        if (card.column !== prevColumn) {
          card.column = prevColumn;
          card.updatedAt = new Date().toISOString();
          await card.save();
        }
      } finally {
        clearCreatePending(cardId);
      }
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
    const card = await Card.findOneBy({ id: cardId });
    if (!card?.sessionId) {
      callback({ error: 'No session to compact' });
      return;
    }

    const initState = await import('../../init-state');
    const client = initState.getClientByNode(card.nodeName);
    if (!client) throw new Error(`node ${card.nodeName} has no client`);

    const cwd = await ensureWorktree(card, client);
    trackSession(cardId, card.sessionId);

    // The context wheel button runs a standard full compaction, same as the
    // chat `/compact` command.
    callback({});
    client.compact({
      sessionId: card.sessionId,
      cwd,
      provider: card.provider,
      model: card.model,
      contextWindow: windowForCard(card),
      summarizeThreshold: card.summarizeThreshold,
      mode: 'full',
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
  const card = await Card.findOneBy({ id: cardId });
  const initState = await import('../../init-state');
  const client = card ? initState.getClientByNode(card.nodeName) : null;
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

    const card = await Card.findOneBy({ id: cardId });
    const initState = await import('../../init-state');
    const client = card ? initState.getClientByNode(card.nodeName) : null;

    const active = !!(card?.sessionId && client?.isActive(card.sessionId));
    const starting = !!card && card.column === 'running' && (!card.sessionId || isCreatePending(cardId));

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
      contextWindow: card ? windowForCard(card) : 200_000,
    });
    callback({});
  } catch (err) {
    console.error(`[session:${cardId}] agent:status error:`, err);
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
