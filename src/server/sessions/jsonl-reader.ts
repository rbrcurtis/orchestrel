import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Sanitize a filesystem path to the Claude Code project directory name.
 * e.g. /home/ryan/Code/orchestrel → -home-ryan-Code-orchestrel
 */
function sanitizePath(p: string): string {
  return p.replace(/\//g, '-');
}

/**
 * Try to read a JSONL file, returning null if not found.
 */
async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Locate a session JSONL file. Checks the expected project dir first,
 * then falls back to scanning all project dirs (handles pre-migration
 * sessions that used process.cwd() instead of the card's project path).
 */
async function findJsonlFile(sessionId: string, cwd: string): Promise<string | null> {
  const filename = `${sessionId}.jsonl`;

  // Try expected location first
  const primary = join(CLAUDE_PROJECTS_DIR, sanitizePath(cwd), filename);
  const raw = await tryRead(primary);
  if (raw) return raw;

  // Fallback: scan project dirs
  try {
    const dirs = await readdir(CLAUDE_PROJECTS_DIR);
    for (const dir of dirs) {
      if (dir === sanitizePath(cwd)) continue; // already tried
      const candidate = join(CLAUDE_PROJECTS_DIR, dir, filename);
      const found = await tryRead(candidate);
      if (found) {
        console.log(`[jsonl-reader] found ${sessionId} in fallback dir: ${dir}`);
        return found;
      }
    }
  } catch {
    // projects dir doesn't exist
  }

  console.log(`[jsonl-reader] ${sessionId}.jsonl not found in any project dir`);
  return null;
}

/**
 * Read a Claude Code session JSONL file and return user/assistant messages
 * in the HistoryMessage format the frontend expects.
 */
export async function readSessionHistory(
  sessionId: string,
  cwd: string,
): Promise<unknown[]> {
  const raw = await findJsonlFile(sessionId, cwd);
  if (!raw) return [];

  const messages: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === 'user' || entry.type === 'assistant') {
        messages.push(entry);
      }
    } catch {
      // skip malformed lines
    }
  }

  return messages;
}
