import type { Column } from './ws-protocol';

// Pi's interactive TUI slash commands (e.g. `/compact`) are only interpreted by
// the Pi CLI front-end. Orchestrel runs Pi headless through orcd's SDK, where a
// typed message goes straight to the model as a prompt — so a user typing
// `/compact` in the chat box gets answered as plain text instead of compacting.
// Detect the commands we support here so callers can route them to the real
// signal instead of forwarding them to the model.

/** True when the prompt is the `/compact` command (optionally with trailing args). */
export function isCompactCommand(prompt: string): boolean {
  const t = prompt.trim();
  return t === '/compact' || t.startsWith('/compact ');
}

// ── App slash commands ───────────────────────────────────────────────────────
// Commands addressed to Orchestrel itself rather than the model. The backend
// strips them from the prompt before it is sent and applies the card action
// after submission, so "great! /merge /qa /archive" prompts the model (with
// the skill/prompt commands expanded by orcd) and then archives the card.
// Like skill/prompt expansion, they are recognized anywhere in the message,
// never inside code regions, and only at start-of-string or after whitespace.

export type AppSlashColumn = Extract<Column, 'done' | 'archive'>;

export const APP_SLASH_COMMANDS: ReadonlyArray<{ name: string; column: AppSlashColumn }> = [
  { name: 'done', column: 'done' },
  { name: 'archive', column: 'archive' },
];

// Same positional rule as skill/prompt expansion (start-of-string or whitespace
// before the slash). The lookahead rejects longer tokens (/done-x, /archive2)
// and path continuations (/done/foo) so pasted paths are never consumed.
const APP_COMMAND_RE = /(^|\s)\/(done|archive)(?![\w/-])/g;

export interface ParsedAppCommands {
  /** The message with every app command removed. */
  text: string;
  /** The column of the LAST app command in the message, or null when none. */
  column: AppSlashColumn | null;
}

export function parseAppCommands(message: string): ParsedAppCommands {
  if (!message.includes('/')) return { text: message, column: null };

  const masked = maskCodeRegions(message);
  let column: AppSlashColumn | null = null;
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(APP_COMMAND_RE)) {
    column = m[2] as AppSlashColumn;
    const idx = m.index ?? 0;
    out += message.slice(last, idx);
    last = idx + m[0].length;
  }
  if (column === null) return { text: message, column: null };
  out += message.slice(last);
  // Removal can leave doubled separators ("great  thanks") and stray edges.
  const text = out.replace(/[ \t]{2,}/g, ' ').trim();
  return { text, column };
}

// Replace the contents of inline `code` spans and fenced ``` blocks with spaces
// of equal length. Same length in → same length out, so match indices from the
// masked string map 1:1 onto the original text. Shared with orcd's skill/prompt
// expansion (inline-commands.ts) so both skip pasted code the same way.
export function maskCodeRegions(text: string): string {
  const chars = text.split('');
  // Fenced blocks first (```...```), then inline spans (`...`).
  maskPattern(chars, /```[\s\S]*?```/g, text);
  maskPattern(chars, /`[^`\n]*`/g, chars.join(''));
  return chars.join('');
}

function maskPattern(chars: string[], re: RegExp, source: string): void {
  for (const m of source.matchAll(re)) {
    const start = m.index ?? 0;
    for (let i = start; i < start + m[0].length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
}
