import { PiSession } from './pi-session';
import type { SessionInfo } from './types';

/**
 * In-memory store of active sessions.
 */
export class SessionStore {
  private sessions = new Map<string, PiSession>();

  get(id: string): PiSession | undefined {
    return this.sessions.get(id);
  }

  add(session: PiSession): void {
    this.sessions.set(session.id, session);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      state: s.state,
      cwd: s.cwd,
      model: s.model,
      provider: s.provider,
    }));
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }
}
