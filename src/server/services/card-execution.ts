import { Card } from '../models/Card';
import { buildPromptWithFiles } from '../sessions/manager';
import { clearCreatePending, markCreatePending, trackSession } from '../controllers/card-sessions';
import { ensureWorktree } from '../sessions/worktree';
import { windowForCard } from '../config/capabilities';
import type { FileRef } from '../../shared/ws-protocol';

export class CardExecutionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function cardAndClient(cardId: number) {
  const card = await Card.findOneBy({ id: cardId });
  if (!card) throw new CardExecutionError(404, 'card_not_found', `Card ${cardId} not found`);

  const initState = await import('../init-state');
  const client = initState.getClientByNode(card.nodeName);
  if (!client?.isConnected()) {
    throw new CardExecutionError(503, 'node_unavailable', `Node ${card.nodeName} is not connected`);
  }
  return { card, client };
}

export async function submitCardPrompt(cardId: number, message: string, files?: FileRef[]): Promise<Card> {
  if (!message.trim()) throw new CardExecutionError(422, 'invalid_prompt', 'Prompt message must not be empty');

  const { card, client } = await cardAndClient(cardId);
  if (card.column === 'done' || card.column === 'archive') {
    throw new CardExecutionError(409, 'card_not_promptable', `Card ${cardId} is ${card.column}`);
  }

  const prompt = buildPromptWithFiles(message, files);
  card.promptsSent = (card.promptsSent ?? 0) + 1;

  if (card.sessionId && client.isActive(card.sessionId)) {
    trackSession(cardId, card.sessionId);
    client.message(card.sessionId, prompt);
    if (card.column !== 'running') card.column = 'running';
    card.updatedAt = new Date().toISOString();
    await card.save();
    console.log(`[session:${cardId}] prompt accepted by active session ${card.sessionId.slice(0, 8)}`);
    return card;
  }

  const prevColumn = card.column;
  markCreatePending(cardId);
  try {
    if (card.column !== 'running') {
      card.column = 'running';
      card.updatedAt = new Date().toISOString();
      await card.save();
    }

    const cwd = await ensureWorktree(card, client);
    const window = windowForCard(card);
    const sessionId = await client.create({
      prompt,
      cwd,
      provider: card.provider,
      model: card.model,
      sessionId: card.sessionId ?? undefined,
      contextWindow: window,
      summarizeThreshold: card.summarizeThreshold,
      effort: card.thinkingLevel === 'off' ? 'disabled' : card.thinkingLevel,
    });

    card.sessionId = sessionId;
    card.contextWindow = window;
    trackSession(cardId, sessionId);
    card.updatedAt = new Date().toISOString();
    await card.save();
    console.log(`[session:${cardId}] prompt started session ${sessionId.slice(0, 8)}`);
    return card;
  } catch (err) {
    console.error(`[session:${cardId}] prompt submission failed:`, err);
    if (card.column !== prevColumn) {
      card.column = prevColumn;
      card.updatedAt = new Date().toISOString();
      await card.save();
    }
    if (err instanceof CardExecutionError) throw err;
    throw new CardExecutionError(503, 'session_start_failed', err instanceof Error ? err.message : String(err));
  } finally {
    clearCreatePending(cardId);
  }
}

export async function stopCardExecution(cardId: number): Promise<Card> {
  const { card, client } = await cardAndClient(cardId);
  if (!card.sessionId || !client.isActive(card.sessionId)) {
    throw new CardExecutionError(409, 'card_not_running', `Card ${cardId} has no active turn`);
  }
  client.cancel(card.sessionId);
  return card;
}

export async function compactCardSession(cardId: number): Promise<Card> {
  const { card, client } = await cardAndClient(cardId);
  if (!card.sessionId) throw new CardExecutionError(409, 'session_not_found', `Card ${cardId} has no session`);

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
  return card;
}
