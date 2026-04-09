import { resolve } from 'path';
import type { ActiveSession, SessionStartOpts } from './types';
import type { FileRef } from '../../shared/ws-protocol';
import { consumeSession } from './consumer';
import { ensureWorktree } from './worktree';
import { Card } from '../models/Card';
import { AppDataSource } from '../models/index';
import { addUserMessage, getMessages } from './conversation-store';

/** Prepend file-path instructions to a prompt when files are attached. */
export function buildPromptWithFiles(message: string, files?: FileRef[]): string {
  if (!files?.length) return message;
  for (const f of files) {
    if (!resolve(f.path).startsWith('/tmp/orchestrel-uploads/')) {
      throw new Error(`Invalid file path: ${f.path}`);
    }
  }
  const fileList = files.map((f) => `- ${f.path} (${f.name}, ${f.mimeType})`).join('\n');
  return `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${message}`;
}

/** Build system prompt with working directory for meridian's extractClientCwd. */
function buildSystemPrompt(cwd: string): string {
  return `<env>\nWorking directory: ${cwd}\n</env>`;
}

export class SessionManager {
  private sessions = new Map<number, ActiveSession>();

  async start(
    cardId: number,
    prompt: string,
    opts: SessionStartOpts,
  ): Promise<ActiveSession> {
    // If session already active, send as follow-up instead
    const existing = this.sessions.get(cardId);
    if (existing && (existing.status === 'running' || existing.status === 'starting' || existing.status === 'retry')) {
      this.sendFollowUp(cardId, prompt);
      return existing;
    }

    // Load card and ensure worktree
    const card = await AppDataSource.getRepository(Card).findOneByOrFail({ id: cardId });
    const cwd = await ensureWorktree(card);

    // Add user message to conversation store
    addUserMessage(cardId, prompt);

    const meridianSessionId = opts.resume ?? `card-${cardId}-${Date.now()}`;

    const session: ActiveSession = {
      cardId,
      sessionId: null,
      meridianSessionId,
      provider: opts.provider,
      model: opts.model,
      status: 'starting',
      promptsSent: 1,
      turnsCompleted: 0,
      turnCost: 0,
      turnUsage: null,
      cwd,
      abortController: new AbortController(),
      stopTimeout: null,
    };

    this.sessions.set(cardId, session);

    // Fire-and-forget consumer
    consumeSession(session, buildSystemPrompt(cwd), (s) => {
      if (s.stopTimeout) clearTimeout(s.stopTimeout);
      this.sessions.delete(s.cardId);
    });

    return session;
  }

  sendFollowUp(cardId: number, message: string): void {
    const session = this.sessions.get(cardId);
    if (!session) throw new Error(`No active session for card ${cardId}`);

    // Add to conversation store
    addUserMessage(cardId, message);
    session.promptsSent++;
    session.status = 'starting';

    // Start a new consumer for the follow-up (new HTTP request to meridian)
    consumeSession(session, buildSystemPrompt(session.cwd), (s) => {
      if (s.stopTimeout) clearTimeout(s.stopTimeout);
      this.sessions.delete(s.cardId);
    });
  }

  stop(cardId: number): void {
    const session = this.sessions.get(cardId);
    if (!session) return;

    console.log(`[session:${session.sessionId ?? cardId}] stop requested`);
    session.status = 'stopped';
    session.abortController.abort();

    // Hard kill fallback
    session.stopTimeout = setTimeout(() => {
      if (!this.sessions.has(cardId)) return;
      console.log(`[session:${session.sessionId ?? cardId}] abort timeout, forcing cleanup`);
      this.sessions.delete(cardId);
    }, 5_000);
  }

  setModel(cardId: number, provider: string, model: string): void {
    const session = this.sessions.get(cardId);
    if (!session) return;

    session.provider = provider;
    session.model = model;
    console.log(`[session:${session.sessionId ?? cardId}] model changed to ${provider}:${model}`);
  }

  get(cardId: number): ActiveSession | undefined {
    return this.sessions.get(cardId);
  }

  has(cardId: number): boolean {
    return this.sessions.has(cardId);
  }

  isActive(cardId: number): boolean {
    const s = this.sessions.get(cardId);
    if (!s) return false;
    return s.status === 'starting' || s.status === 'running' || s.status === 'retry';
  }
}
