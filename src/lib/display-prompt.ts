import { createHash } from 'node:crypto';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export const DISPLAY_PROMPT_ENTRY = 'orchestrel-display-prompt';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface DisplayPrompt {
  displayText: string;
  expandedHash: string;
}

function displayPrompt(entry: SessionEntry): DisplayPrompt | undefined {
  if (entry.type !== 'custom' || entry.customType !== DISPLAY_PROMPT_ENTRY || !isRecord(entry.data)) return undefined;
  const displayText = getString(entry.data.displayText);
  const expandedHash = getString(entry.data.expandedHash);
  return displayText && expandedHash ? { displayText, expandedHash } : undefined;
}

/**
 * Original invocations keyed by the hash of the expansion Pi persisted, in branch
 * order. Both the paged history reader and the live transcript projection consume
 * this so an expanded skill or prompt template is never shown to the user.
 */
export function collectDisplayPrompts(entries: SessionEntry[]): Map<string, string[]> {
  const replacements = new Map<string, string[]>();
  for (const entry of entries) {
    const replacement = displayPrompt(entry);
    if (!replacement) continue;
    const texts = replacements.get(replacement.expandedHash) ?? [];
    texts.push(replacement.displayText);
    replacements.set(replacement.expandedHash, texts);
  }
  return replacements;
}

function collapseLegacySkillBlocks(text: string): string {
  return text.replace(
    /<skill name="([a-z0-9-]+)"[^>]*>[\s\S]*?<\/skill>/g,
    (_block, name: string) => `/${name}`,
  );
}

/**
 * Verified original invocation for a persisted user text. Legacy sessions without
 * display metadata fall back to collapsing the injected `<skill>` block.
 */
export function originalPromptText(text: string, replacements: Map<string, string[]>): string {
  const hash = createHash('sha256').update(text).digest('hex');
  return replacements.get(hash)?.shift() ?? collapseLegacySkillBlocks(text);
}
