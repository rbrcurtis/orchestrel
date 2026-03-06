import { ClaudeSession } from './protocol';

class SessionManager {
  private sessions = new Map<string, ClaudeSession>();

  create(cardId: number, cwd: string, resumeSessionId?: string): ClaudeSession {
    const key = `card-${cardId}`;
    const existing = this.sessions.get(key);
    if (existing && existing.status === 'running') {
      throw new Error(`Session already running for card ${cardId}`);
    }
    const session = new ClaudeSession(cwd, resumeSessionId);
    this.sessions.set(key, session);
    return session;
  }

  get(cardId: number): ClaudeSession | undefined {
    return this.sessions.get(`card-${cardId}`);
  }

  async kill(cardId: number): Promise<void> {
    const key = `card-${cardId}`;
    const session = this.sessions.get(key);
    if (session) {
      await session.kill();
      this.sessions.delete(key);
    }
  }
}

export const sessionManager = new SessionManager();
