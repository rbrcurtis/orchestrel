import { EventEmitter } from 'events';
import type { AgentSession } from './types';
import { createAgentSession } from './factory';
import type { CreateSessionOpts } from './factory';
import { SessionTailer } from './tailer';

class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private tailers = new Map<string, SessionTailer>();

  create(cardId: number, opts: CreateSessionOpts): AgentSession {
    const key = `card-${cardId}`;
    const existing = this.sessions.get(key);
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      console.log(`[session:${cardId}] blocked: session already ${existing.status}`);
      throw new Error(`Session already ${existing.status} for card ${cardId}`);
    }
    const session = createAgentSession(opts);
    console.log(`[session:${cardId}] created, agent=${opts.agentType}, model=${opts.model}, thinking=${opts.thinkingLevel}, resume=${!!opts.resumeSessionId}`);
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

  startTailing(cardId: number, filePath: string): SessionTailer {
    const key = `card-${cardId}`;
    const existing = this.tailers.get(key);
    if (existing) return existing;
    const tailer = new SessionTailer(filePath, cardId);
    this.tailers.set(key, tailer);
    tailer.start();
    tailer.on('stale', () => {
      this.tailers.delete(key);
    });
    return tailer;
  }

  getTailer(cardId: number): SessionTailer | undefined {
    return this.tailers.get(`card-${cardId}`);
  }

  stopTailing(cardId: number): void {
    const key = `card-${cardId}`;
    const tailer = this.tailers.get(key);
    if (tailer) {
      tailer.stop();
      this.tailers.delete(key);
    }
  }
}

export const sessionManager = new SessionManager();
