/* User preference injection. The backend already tags every session start with
 * who acted (OrcdAuthor); orcd resolves that user's local preference file
 * (data/preferences/<email>.md, maintained by the preference maintainer) and
 * injects it into the first prompt, then re-embeds it in each background
 * compaction summary so it survives the 20k-tail cut. Sessions without a human
 * author (auto-start, sleep wake, warm rehydration) fall back to the node's
 * defaultUser from orcd.yaml. */
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

/** Prepend the user's preferences to the session's first prompt. */
export function withUserPrefs(prompt: string, prefs: string): string {
  return `User preferences for this person (apply for the entire session):\n${prefs}\n\n${prompt}`;
}

/** Re-append preferences to a BGC summary: once the first prompt scrolls past
 * the 20k tail the session would otherwise forget them. Riding the summary also
 * carries them into every subsequent compaction via previousSummary. */
export function prefsSummarySection(prefs: string): string {
  return `\n\n## User preferences (standing; keep applying these)\n${prefs}`;
}
