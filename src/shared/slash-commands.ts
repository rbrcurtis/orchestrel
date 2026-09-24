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

// ── Injected command content ──────────────────────────────────────────────────
// orcd keeps the user's slash command VERBATIM in the persisted user message and
// appends the expanded skill/prompt content after this marker. Replayed history
// (paged, live snapshot, and cached frontend) strips everything from the marker
// so the transcript shows exactly what the user typed. A marker is required
// because prompt templates carry no <skill> wrapper to strip heuristically, and
// legacy sessions embedded the expansion in place.
export const INJECTED_COMMANDS_MARKER = '\n\n<!-- orchestrel:injected-commands -->\n';

/** The user's text with any appended injected-command content removed. */
export function stripInjectedCommands(text: string): string {
  const i = text.indexOf(INJECTED_COMMANDS_MARKER);
  return i === -1 ? text : text.slice(0, i).trimEnd();
}

// ── App slash commands ───────────────────────────────────────────────────────
// Commands addressed to Orchestrel itself rather than the model. The backend
// strips them from the prompt before it is sent and applies the card action
// after submission, so "great! /merge /qa /archive" prompts the model (with
// the skill/prompt commands expanded by orcd) and then archives the card.
// Like skill/prompt expansion, they are recognized anywhere in the message,
// never inside code regions, and only at start-of-string or after whitespace.

// /sleep parks the card in ready until a computed time, so it never prompts —
// the wake time is an argument, not prompt text (see submitCardPrompt).
export type AppSlashAction = Extract<Column, 'done' | 'archive' | 'ready'> | 'delete' | 'sleep';

export const APP_SLASH_COMMANDS: ReadonlyArray<{ name: string; action: AppSlashAction }> = [
  { name: 'done', action: 'done' },
  { name: 'archive', action: 'archive' },
  { name: 'ready', action: 'ready' },
  { name: 'sleep', action: 'sleep' },
  { name: 'delete', action: 'delete' },
];

// Same positional rule as skill/prompt expansion (start-of-string or whitespace
// before the slash). The lookahead rejects longer tokens (/done-x, /delete2)
// and path continuations (/done/foo) so pasted paths are never consumed.
const APP_COMMAND_RE = /(^|\s)\/(done|archive|ready|sleep|delete)(?![\w/-])/g;

export interface ParsedAppCommands {
  /** The message with every app command removed. */
  text: string;
  /** The action of the LAST app command in the message, or null when none. */
  action: AppSlashAction | null;
  /** Time phrase of the last /sleep (for example "12 hours"), or null. */
  sleepPhrase: string | null;
}

export function parseAppCommands(message: string): ParsedAppCommands {
  if (!message.includes('/')) return { text: message, action: null, sleepPhrase: null };

  const masked = maskCodeRegions(message);
  const matches = [...masked.matchAll(APP_COMMAND_RE)];
  if (matches.length === 0) return { text: message, action: null, sleepPhrase: null };

  let action: AppSlashAction | null = null;
  let sleepPhrase: string | null = null;
  let out = '';
  let last = 0;
  matches.forEach((m, i) => {
    const start = m.index ?? 0;
    let end = start + m[0].length;
    // /sleep carries its argument as the text after the command. It runs to the
    // next app command, the end of its line, or the end of the message — so
    // a multi-line message keeps the text below as a prompt while the first
    // line supplies the phrase, and a bare phrase leaves nothing to prompt.
    if (m[2] === 'sleep') {
      const next = matches[i + 1]?.index ?? message.length;
      const lineEnd = message.indexOf('\n', end);
      const stop = Math.min(next, lineEnd === -1 ? message.length : lineEnd);
      sleepPhrase = message.slice(end, stop).trim();
      end = stop;
    }
    action = m[2] as AppSlashAction;
    out += message.slice(last, start);
    last = end;
  });
  out += message.slice(last);
  // Removal can leave doubled separators ("great  thanks") and stray edges.
  const text = out.replace(/[ \t]{2,}/g, ' ').trim();
  return { text, action, sleepPhrase: action === 'sleep' ? sleepPhrase : null };
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
