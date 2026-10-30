/* User preference injection. The preference files are written by the preference
 * maintainer on the box that owns orchestrel.db; the backend is the only node
 * that can see all of them, so on card creation it ships the acting user's file
 * body and this node WRITES it to its own data/preferences/<email>.md. From
 * there everything is local and unchanged: a new session reads that file and
 * hands it to Pi as an appended system-prompt section, and because the system
 * prompt is carried on every request it survives compaction, so every later turn
 * — including after BGC — sees the same preferences.
 *
 * The sync is per card creation, so a node's copy can lag the backend's until
 * the next card that user starts there. That is deliberate: the alternative was
 * shipping the body with every session action, which the node would then have to
 * treat as the source of truth instead of its own file. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
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

/**
 * Write a user's preference file, as shipped by the backend on card creation.
 * An empty body writes an empty file on purpose: the backend is the source of
 * truth, so "this user has no preferences" must clear a stale local copy rather
 * than leave it in place.
 *
 * Atomic (write beside the target, then rename) because two cards for the same
 * user can start at once and a session reads this file while it is being replaced.
 * A failed sync never fails the card: the session still runs, on the old copy.
 */
export function saveUserPrefs(email: string, body: string, dir: string): void {
  // An email is a file name here, so anything that could escape the directory is
  // refused rather than joined.
  const trimmedEmail = email.trim();
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(trimmedEmail)) {
    console.warn(`[orcd] preference sync skipped: unusable email ${JSON.stringify(email)}`);
  } else {
    const target = join(dir, `${trimmedEmail}.md`);
    const trimmed = body.trim();
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${target}.tmp-${process.pid}`;
      writeFileSync(tmp, trimmed ? `${trimmed}\n` : '', { mode: 0o644 });
      renameSync(tmp, target);
      console.log(`[orcd] preferences synced for ${trimmedEmail} (${trimmed.length} chars)`);
    } catch (err) {
      console.error(`[orcd] preference sync failed for ${trimmedEmail}:`, err instanceof Error ? err.message : err);
    }
  }
}
