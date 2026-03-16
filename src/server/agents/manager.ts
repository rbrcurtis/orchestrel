import { EventEmitter } from 'events';
import type { AgentSession } from './types';
import { createAgentSession } from './factory';
import type { CreateSessionOpts } from './factory';

class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();

  create(cardId: number, opts: CreateSessionOpts): AgentSession {
    const key = `card-${cardId}`;
    const existing = this.sessions.get(key);
    if (existing && (existing.status === 'running' || existing.status === 'starting' || existing.status === 'retry')) {
      console.log(`[session:${cardId}] blocked: session already ${existing.status}`);
      throw new Error(`Session already ${existing.status} for card ${cardId}`);
    }
    const session = createAgentSession(opts);
    console.log(`[session:${cardId}] created, provider=${opts.providerID}, model=${opts.model}, thinking=${opts.thinkingLevel}, resume=${!!opts.resumeSessionId}`);
    this.sessions.set(key, session);
    this.emit('session', cardId, session);
    return session;
  }

  get(cardId: number): AgentSession | undefined {
    return this.sessions.get(`card-${cardId}`);
  }

  async kill(cardId: number): Promise<void> {
    const key = `card-${cardId}`;
    const session = this.sessions.get(key);
    if (session) {
      console.log(`[session:${cardId}] kill() called`);
      await session.kill();
      this.sessions.delete(key);
    }
  }
}

export const sessionManager = new SessionManager();
