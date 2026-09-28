/* Session excerpt builder: collapse a pi session JSONL into a bounded text
 * excerpt for the consolidation agent. Thinking blocks are dropped; tool call
 * arguments and results are truncated. Newest content wins when over budget. */
import { readFileSync } from 'fs';

export interface Excerpt {
  sessionId: string;
  cwd: string;
  startedAt: string;
  text: string;
  tokenEstimate: number;
}

interface SessionEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  customType?: string;
  data?: unknown;
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface PendingAuthor {
  kind: string;
  userId: number;
  email: string;
}

const TOOL_ARGS_CAP = 200;
const TOOL_RESULT_CAP = 400;

export const SECRETS_PATTERN = /sk-[A-Za-z0-9]{20,}|Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Distinct human (non-system) authors in a session, by numeric users.id, with the email used for the canonical preference title. */
export function listHumanAuthors(path: string): Array<{ userId: number; email: string }> {
  const byId = new Map<number, string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      continue;
    }
    if (entry.type === 'custom' && entry.customType === 'orc.author') {
      const a = entry.data as { kind?: string; userId?: number; email?: string } | undefined;
      if (a && a.kind === 'human' && typeof a.userId === 'number' && a.userId > 0 && !byId.has(a.userId)) {
        byId.set(a.userId, a.email ?? `user-${a.userId}`);
      }
    }
  }
  return [...byId].map(([userId, email]) => ({ userId, email }));
}

export function buildExcerpt(path: string, maxTokens: number, opts?: { humanOnly?: boolean; userId?: number }): Excerpt {
  let sessionId = '';
  let cwd = '';
  let startedAt = '';
  // The author of the next user message. orcd writes an `orc.author` custom
  // entry immediately before each user message; we carry it forward so the
  // excerpt can attribute each turn (human vs system) to the maintainer.
  let pendingAuthor: PendingAuthor | null = null;
  const parts: string[] = [];

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      continue;
    }
    if (entry.type === 'session') {
      sessionId = entry.id ?? sessionId;
      cwd = entry.cwd ?? cwd;
      startedAt = entry.timestamp ?? startedAt;
      continue;
    }
    if (entry.type === 'custom' && entry.customType === 'orc.author') {
      const a = entry.data as { userId?: number; email?: string; kind?: string } | undefined;
      if (a) pendingAuthor = { kind: a.kind ?? 'system', userId: a.userId ?? 0, email: a.email ?? 'system' };
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const role = entry.message.role;
    const content = entry.message.content;

    // Preference pass: keep only the target human's own user turns. Preferences
    // and corrections live in what the person typed; system prompts and other
    // people's prompts must never feed one user's preference memory.
    if (opts?.humanOnly) {
      if (role === 'user' && pendingAuthor?.kind === 'human' && (opts.userId == null || pendingAuthor.userId === opts.userId)) {
        parts.push(redact(`USER: ${contentText(content)}`));
      }
      pendingAuthor = null;
      continue;
    }

    if (role === 'user') {
      if (pendingAuthor) {
        parts.push(redact(`AUTHOR: kind=${pendingAuthor.kind} userId=${pendingAuthor.userId} email=${pendingAuthor.email}`));
        pendingAuthor = null;
      }
      parts.push(redact(`USER: ${contentText(content)}`));
    } else if (role === 'assistant') {
      for (const block of contentBlocks(content)) {
        if (block.type === 'text') parts.push(redact(`ASSISTANT: ${block.text}`));
        else if (block.type === 'toolCall')
          parts.push(`TOOL CALL: ${block.name}(${truncate(redact(JSON.stringify(block.arguments)), TOOL_ARGS_CAP)})`);
        // thinking blocks intentionally dropped
      }
    } else if (role === 'toolResult') {
      const rc = entry.message as SessionEntry['message'] & { toolName?: string; content?: unknown };
      parts.push(`TOOL RESULT ${rc.toolName ?? ''}: ${truncate(redact(contentText(content)), TOOL_RESULT_CAP)}`);
    }
  }

  let text = trimToBudget(parts, maxTokens);
  return { sessionId, cwd, startedAt, text, tokenEstimate: Math.ceil(text.length / 4) };
}

function contentBlocks(content: unknown): Array<{ type: string; text?: string; name?: string; arguments?: unknown }> {
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ type: string; text?: string; name?: string; arguments?: unknown }> = [];
  for (const b of content) {
    if (b && typeof b === 'object') {
      const rec = b as Record<string, unknown>;
      const type = String(rec.type ?? '');
      const block: { type: string; text?: string; name?: string; arguments?: unknown } = { type };
      if (typeof rec.text === 'string') block.text = rec.text;
      if (typeof rec.name === 'string') block.name = rec.name;
      if ('arguments' in rec) block.arguments = rec.arguments;
      blocks.push(block);
    }
  }
  return blocks;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of contentBlocks(content)) {
    if (block.type === 'text' && block.text) parts.push(block.text);
  }
  return parts.join('\n');
}

function redact(s: string): string {
  return s.replace(SECRETS_PATTERN, '[redacted]');
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}…`;
}

function trimToBudget(parts: string[], maxTokens: number): string {
  const charBudget = maxTokens * 4;
  // The joined output adds a newline per extra kept part; count it so
  // tokenEstimate never exceeds maxTokens when the parts fit exactly.
  let total = 0;
  let start = parts.length;
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = total + parts[i].length + (total === 0 ? 0 : 1);
    if (next > charBudget) break;
    total = next;
    start = i;
  }
  return parts.slice(start).join('\n');
}
