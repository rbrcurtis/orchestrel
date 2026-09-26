import { readFileSync, rmSync } from 'fs';
import { resolve, sep } from 'path';
import { messageBus } from '../bus';
import { Card } from '../models/Card';
import { buildPromptWithFiles } from '../sessions/manager';
import { clearCreatePending, markCreatePending, trackSession } from '../controllers/card-sessions';
import { ensureWorktree } from '../sessions/worktree';
import { windowForCard } from '../config/capabilities';
import { parseAppCommands, type AppSlashAction } from '../../shared/slash-commands';
import type { OrcdClient } from '../orcd-client';
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

export async function submitCardPrompt(cardId: number, message: string, files?: FileRef[]): Promise<Card | null> {
  // App slash commands (/done, /archive, /ready, /delete) are addressed to
  // Orchestrel, not the model: strip them from the prompt, send what remains,
  // then apply the card action. A message of only app commands acts without
  // prompting. The moves go through cardService.updateCard — the same path as a
  // drag — so a mid-turn move keeps the session alive and the card parks when
  // it exits.
  const { text, action } = parseAppCommands(message);

  // Delete is terminal: the card is removed outright, so there is nothing to
  // prompt first — any remaining text is discarded with it. Returns null to
  // tell callers the card no longer exists.
  if (action === 'delete') {
    console.log(`[session:${cardId}] app command /delete: deleting card`);
    const { cardService } = await import('./card');
    await cardService.deleteCard(cardId);
    return null;
  }

  const hasPrompt = text.trim().length > 0 || (files?.length ?? 0) > 0;

  if (!hasPrompt) {
    if (!action) throw new CardExecutionError(422, 'invalid_prompt', 'Prompt message must not be empty');
    console.log(`[session:${cardId}] app command /${action}: moving card without prompting`);
    return moveCardToColumn(cardId, action);
  }

  const card = await sendPrompt(cardId, text, files);
  if (action) {
    console.log(`[session:${cardId}] app command /${action}: moving card after prompt`);
    return moveCardToColumn(cardId, action);
  }
  return card;
}

// Everyone viewing the card must see the prompt, not just the socket that sent
// it: the sender echoes it optimistically client-side, but other viewers have
// nothing until the next history load without this broadcast.
function broadcastUserPrompt(cardId: number, text: string): void {
  if (!text.trim()) {
    console.log(`[session:${cardId}] skipping prompt broadcast — empty text`);
    return;
  }
  messageBus.publish(`card:${cardId}:sdk`, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

// Move a card exactly like a drag would: cardService.updateCard applies the
// session lifecycle (mid-turn done/archive moves keep the session alive) and
// the save fires the board:changed handlers (worktree cleanup, reaper). Delete
// never reaches here — submitCardPrompt short-circuits it before prompting.
type MoveAction = Extract<AppSlashAction, 'done' | 'archive' | 'ready'>;
async function moveCardToColumn(cardId: number, column: MoveAction): Promise<Card> {
  const data: Partial<Card> = { column };
  // Position-sorted columns (all but archive) sort by position; append the
  // card at the end.
  if (column === 'done' || column === 'ready') {
    const last = await Card.findOne({ where: { column }, order: { position: 'DESC' } });
    data.position = (last?.position ?? -1) + 1;
  }
  const { cardService } = await import('./card');
  return cardService.updateCard(cardId, data);
}

// Prompt uploads land in the backend's /tmp, but the agent runs on the card's
// node. Stage the bytes there — same mechanism as initial card attachments —
// so the path embedded in the prompt exists wherever the session runs.
async function stagePromptFiles(client: OrcdClient, cardId: number, files: FileRef[]): Promise<FileRef[]> {
  const uploadRoot = `${resolve('/tmp/orchestrel-uploads')}${sep}`;
  const stagedRoot = `${resolve('/tmp/orchestrel-attachments')}${sep}`;
  const staged: FileRef[] = [];
  for (const f of files) {
    const path = resolve(f.path);
    if (path.startsWith(stagedRoot)) {
      staged.push(f);
      continue;
    }
    if (!path.startsWith(uploadRoot)) {
      throw new CardExecutionError(422, 'invalid_attachment', `Invalid attachment path: ${f.path}`);
    }
    staged.push(await client.stageFile({ cardId, file: f, bytes: readFileSync(path) }));
    rmSync(path, { force: true });
  }
  return staged;
}

async function sendPrompt(cardId: number, message: string, files?: FileRef[]): Promise<Card> {
  // A prompt reopens a card from any column, including done/archive: the
  // explicit prompt is what pulls it back into play.
  const { card, client } = await cardAndClient(cardId);

  const staged = files?.length ? await stagePromptFiles(client, cardId, files) : [];
  const prompt = buildPromptWithFiles(message, staged);
  card.promptsSent = (card.promptsSent ?? 0) + 1;

  if (card.sessionId && client.isActive(card.sessionId)) {
    trackSession(cardId, card.sessionId);
    // Carry the current card effort so the active session re-syncs its
    // thinking level before this prompt (see orcd run()).
    client.message(card.sessionId, prompt, card.thinkingLevel === 'off' ? 'disabled' : card.thinkingLevel);
    if (card.column !== 'running') card.column = 'running';
    card.updatedAt = new Date().toISOString();
    await card.save();
    broadcastUserPrompt(cardId, message);
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
    broadcastUserPrompt(cardId, message);
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
