import { query } from '@anthropic-ai/claude-agent-sdk';
import { createPromptChannel, userMessage } from './prompt-channel';
import type { ActiveSession, SessionStartOpts } from './types';
import { consumeSession } from './consumer';
import { ensureWorktree } from './worktree';
import { Card } from '../models/Card';
import { AppDataSource } from '../models/index';

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

    const channel = createPromptChannel();
    channel.push(userMessage(prompt));

    const isKiroProvider = opts.provider !== 'anthropic';
    const modelStr = isKiroProvider ? `${opts.provider}:${opts.model}` : opts.model;
    const q = query({
      prompt: channel.iterator,
      options: {
        model: modelStr,
        cwd,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project'],
        includePartialMessages: true,
        ...(opts.resume ? { resume: opts.resume } : {}),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
          ...(isKiroProvider ? { ANTHROPIC_BASE_URL: process.env.KIRO_PROXY_URL ?? 'http://127.0.0.1:3457' } : {}),
        },
      },
    });

    const session: ActiveSession = {
      cardId,
      query: q,
      sessionId: null,
      provider: opts.provider,
      model: opts.model,
      status: 'starting',
      promptsSent: 1,
      turnsCompleted: 0,
      turnCost: 0,
      turnUsage: null,
      cwd,
      pushMessage: channel.push,
      closeInput: channel.close,
      stopTimeout: null,
    };

    this.sessions.set(cardId, session);

    // Fire-and-forget consumer loop
    consumeSession(session, (s) => {
      if (s.stopTimeout) clearTimeout(s.stopTimeout);
      this.sessions.delete(s.cardId);
    });

    return session;
  }

  sendFollowUp(cardId: number, message: string): void {
    const session = this.sessions.get(cardId);
    if (!session) throw new Error(`No active session for card ${cardId}`);

    session.promptsSent++;
    session.status = 'starting';

    session.query.streamInput(
      (async function* () {
        yield {
          type: 'user' as const,
          message: {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: message }],
          },
          parent_tool_use_id: null,
        };
      })(),
    );
  }

  stop(cardId: number): void {
    const session = this.sessions.get(cardId);
    if (!session) return;

    console.log(`[session:${session.sessionId ?? cardId}] stop requested`);
    session.status = 'stopped';
    session.query.interrupt().catch((err) => {
      console.log(`[session:${session.sessionId ?? cardId}] interrupt cleanup: ${err}`);
    });
  }

  setModel(cardId: number, provider: string, model: string): void {
    const session = this.sessions.get(cardId);
    if (!session) return;

    const modelStr = `${provider}:${model}`;
    session.query.setModel(modelStr);
    session.provider = provider;
    session.model = model;
    console.log(`[session:${session.sessionId ?? cardId}] model changed to ${modelStr}`);
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
