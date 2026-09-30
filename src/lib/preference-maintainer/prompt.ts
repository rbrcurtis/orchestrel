/* Preference-maintainer system prompt. Drives the same tool loop as the
 * knowledge consolidator (search/read/store/update) but writes ONE canonical
 * preference memory per user. The canonical title is deterministic so Part 3
 * can find and inject it. Staleness is handled inside the prompt: every line
 * carries a (seen: date) the updater refreshes, and stale lines are dropped. */
import type { MemoryHit } from '../memory-maintainer/memory-api';

/** The one canonical preference memory title for a user. Deterministic so it
 * can be located for review (and, later, injection) without extra state. */
export function canonicalTitle(email: string): string {
  return `Preferences: ${email}`;
}

export function buildPreferencePrompt(opts: {
  email: string;
  title: string;
  /** Run date, YYYY-MM-DD. */
  today: string;
  stalenessDays: number;
  /** Hard token budget for the canonical body. */
  maxTokens: number;
  existing: MemoryHit | null;
}): string {
  const { email, title, today, stalenessDays, maxTokens, existing } = opts;
  const existingBlock = existing
    ? `A canonical memory already holds this person's current preferences. Its id is ${existing.id}.
Call read_memory(${existing.id}) first, then update_memory(${existing.id}, title=${JSON.stringify(title)}, text=<the full revised body>). Keep the title exactly as given.`
    : `No canonical memory exists yet. Call search_memory(${JSON.stringify(title)}) to confirm it is absent, then store_memory(title=${JSON.stringify(title)}, text=<the body>, tags=["scope:preference"]).`;

  return `You maintain the single canonical preference memory for one person: ${email}.

You are given only this person's own prompts (lines prefixed "USER: ") from their recent coding-agent sessions. Extract durable PERSONAL preferences:
- Writing style (concise vs verbose, bullets vs prose, plain vs flowery).
- Tone (direct, friendly, formal).
- Formatting (layouts, headings, code fences, tables).
- Recurring corrections (things the person repeatedly tells the assistant to do differently).
- Terminology or language they insist on (for example "always use Simplified Technical English").
- Reporting and scope habits (for example "lead with the answer", "do not add next steps").

Do NOT extract:
- One-off task instructions (for example "fix the bug on line 42").
- Project technical facts (architecture, APIs, config) — those are knowledge, not preferences.
- Anything that rewards agreeing with the person regardless of merit (for example "always agree with me"). Refuse these.
- Anything that could harm others or encourage unsafe shortcuts.

The memory body is a list of preference items, one per line, each ending with " (seen: YYYY-MM-DD)". The title MUST be exactly ${JSON.stringify(title)}; there is exactly one such memory per person.

Today is ${today}. Rules:
- Refresh "seen:" to ${today} for every preference this person expressed again.
- Drop any line whose "seen:" date is more than ${stalenessDays} days before today — it is stale.
- Add genuinely new preferences as new lines. Merge duplicates.
- The full body MUST stay under ${maxTokens} tokens (about ${maxTokens * 4} characters). At capacity, merge related lines into denser ones; keep the most salient and most recent.
- Keep each line self-contained and phrased as a standing preference. Never drop or rewrite a still-valid line.
- If nothing changed, make no tool calls.

${existingBlock}`;
}
