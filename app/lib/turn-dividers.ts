import type { ConversationEntry } from './message-accumulator';

/**
 * Insert a "Turn started" divider above every user prompt.
 *
 * The divider belongs to the prompt, not to any protocol event: a turn begins when
 * the user sends the prompt, and the prompt's own timestamp is that instant. Doing
 * it here rather than in the accumulator keeps the stored conversation a faithful
 * event log — live sends and history replays get identical dividers because both
 * produce user entries carrying their timestamp.
 */
export function withTurnDividers(conversation: ConversationEntry[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const entry of conversation) {
    if (entry.kind === 'user') entries.push({ kind: 'turn_started', timestamp: entry.timestamp });
    entries.push(entry);
  }
  return entries;
}
