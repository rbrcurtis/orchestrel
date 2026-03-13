import { join } from 'path'
import { existsSync } from 'fs'

/** Get the directory containing Kiro CLI session files */
export function getKiroSessionDir(agentProfile: string): string {
  return join(agentProfile, '.kiro', 'sessions', 'cli')
}

/**
 * Get the path to the Kiro session JSONL event log.
 * Files are stored flat: {agentProfile}/.kiro/sessions/cli/{sessionId}.jsonl
 * Returns null if not found.
 */
export function getKiroSessionLogPath(agentProfile: string, sessionId: string): string | null {
  const path = join(agentProfile, '.kiro', 'sessions', 'cli', `${sessionId}.jsonl`)
  return existsSync(path) ? path : null
}
