/* User preference injection. The backend already tags every session start with
 * who acted (OrcdAuthor); orcd resolves that user's local preference file
 * (data/preferences/<email>.md, maintained by the preference maintainer) and
 * hands it to Pi as an appended system-prompt section. The system prompt is
 * carried on every request and survives compaction, so a new session and every
 * later turn — including after BGC — see the same working preferences. Sessions
 * without a human author (auto-start, sleep wake, warm rehydration) fall back to
 * the node's defaultUser from orcd.yaml. */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { OrcdAuthor } from '../shared/orcd-protocol';

export const DEFAULT_PREFERENCES_DIR = join('data', 'preferences');

/** The user whose preference file a session gets. Human authors win; anything
 * else falls back to the node default. */
export function resolvePrefEmail(
  author: OrcdAuthor | undefined,
  defaultUser: string | undefined,
): string | undefined {
  return author && author.kind === 'human' && author.email ? author.email : defaultUser;
}

/** Read a user's preference file. Missing/empty file = no injection, no error. */
export function loadUserPrefs(email: string, dir: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, `${email}.md`), 'utf8');
  } catch {
    // No file for this user is expected (most users have no prefs) — log, don't raise.
    console.log(`[orcd] no preference file for ${email}`);
    return undefined;
  }
  return text.trim() || undefined;
}

/** The system-prompt section carrying the user's preferences. Appended to Pi's
 * base prompt, never to a user message: a preference is a standing instruction
 * for the whole session, not turn content. */
export function prefsSystemBlock(prefs: string): string {
  return `## User preferences (persistent; apply for the entire session)\n${prefs}`;
}
