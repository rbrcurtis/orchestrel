import { join } from 'path'
import { readdirSync, existsSync } from 'fs'

/** Get the directory containing a Kiro session's log files */
export function getKiroSessionDir(agentProfile: string, sessionId: string): string {
  return join(agentProfile, '.kiro', 'sessions', 'cli', sessionId)
}

/**
 * Get the path to the Kiro session JSONL event log.
 * Scans the session directory for a .jsonl file.
 * Returns null if not found.
 */
export function getKiroSessionLogPath(agentProfile: string, sessionId: string): string | null {
  const dir = getKiroSessionDir(agentProfile, sessionId)
  if (!existsSync(dir)) return null

  // Look for a JSONL file in the session directory
  try {
    const files = readdirSync(dir)
    const jsonl = files.find(f => f.endsWith('.jsonl'))
    return jsonl ? join(dir, jsonl) : null
  } catch {
    return null
  }
}
