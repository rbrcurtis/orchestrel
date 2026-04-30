import { OrcdSession } from './session';
import type { SessionInfo } from './types';

/**
 * In-memory store of active sessions.
 */
export class SessionStore {
  private sessions = new Map<string, OrcdSession>();

  get(id: string): OrcdSession | undefined {
    return this.sessions.get(id);
  }

  add(session: OrcdSession): void {
    this.sessions.set(session.id, session);
  }

  /**
   * Register an alias so both ids resolve to the same session. Used when CC
   * forks a session on resume — the original id stays, plus we accept the
   * new id for lookups, prompts, and subscribes.
   */
  alias(existingId: string, newId: string): void {
    const session = this.sessions.get(existingId);
    if (!session) {
      console.log(`[session-store] alias skipped: unknown session ${existingId.slice(0, 8)}`);
      return;
    }
    if (existingId === newId) {
      console.log(`[session-store] alias no-op: ${newId.slice(0, 8)} identical`);
      return;
    }
    this.sessions.set(newId, session);
  }

  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      console.log(`[session-store] remove skipped: unknown session ${id.slice(0, 8)}`);
      return;
    }
    // Remove all keys pointing to this session (handles aliases)
    for (const [k, v] of this.sessions.entries()) {
      if (v === session) this.sessions.delete(k);
    }
  }

  list(): SessionInfo[] {
    const unique = new Set<OrcdSession>(this.sessions.values());
    return [...unique].map((s) => ({
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
