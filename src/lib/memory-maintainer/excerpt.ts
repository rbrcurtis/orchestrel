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
  message?: {
    role?: string;
    content?: unknown;
  };
}

const TOOL_ARGS_CAP = 200;
const TOOL_RESULT_CAP = 400;

export const SECRETS_PATTERN = /sk-[A-Za-z0-9]{20,}|Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function buildExcerpt(path: string, maxTokens: number): Excerpt {
  let sessionId = '';
  let cwd = '';
  let startedAt = '';
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
    if (entry.type !== 'message' || !entry.message) continue;
    const role = entry.message.role;
    const content = entry.message.content;
    if (role === 'user') {
      parts.push(redact(`USER: ${contentText(content)}`));
    } else if (role === 'assistant') {
      for (const block of contentBlocks(content)) {
        if (block.type === 'text') parts.push(redact(`ASSISTANT: ${block.text}`));
        else if (block.type === 'toolCall') parts.push(`TOOL CALL: ${block.name}(${truncate(redact(JSON.stringify(block.arguments)), TOOL_ARGS_CAP)})`);
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
