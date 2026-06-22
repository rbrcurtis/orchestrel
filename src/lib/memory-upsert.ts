/**
 * Pi session memory upsert bridge.
 *
 * Reads Pi session history and builds a durable-memory excerpt. Automatic
 * agent-driven upsert is temporarily disabled until the Pi runtime exposes a
 * safe tool-enabled memory agent path; callers still receive the stable result
 * shape with zero tool counters.
 */
import { getPiSessionMessages } from './pi-session-history';

const LOG = '[memory-upsert]';

export interface MemoryUpsertResult {
  sessionId: string;
  messagesProcessed: number;
  toolCalls: {
    search: number;
    store: number;
    update: number;
    delete: number;
  };
  turns: number;
  durationMs: number;
}

export interface MemoryUpsertOpts {
  sessionId: string;
  projectPath: string;
  projectName: string;
  model: string;
  env?: Record<string, string>;
  memoryBaseUrl: string;
  memoryApiKey: string;
  maxExcerptChars?: number;
  /** Max agent turns. Kept for API compatibility while automatic upsert is paused. */
  maxTurns?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function summarizeJson(value: unknown, maxChars: number): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function extractTextFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return summarizeJson(content, 500);

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (!isRecord(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }

  if (parts.length > 0) return parts.join('\n');
  return summarizeJson(content, 500);
}

function extractContentParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }

    if (block.type === 'tool_use' && typeof block.name === 'string') {
      const input = summarizeJson(block.input, 300);
      parts.push(input ? `[tool_use: ${block.name} ${input}]` : `[tool_use: ${block.name}]`);
      continue;
    }

    if (block.type === 'tool_result') {
      const text = extractTextFromToolResultContent(block.content);
      const suffix = block.is_error === true ? ' error' : '';
      parts.push(`[tool_result${suffix}: ${summarizeJson(text, 500)}]`);
    }
  }

  return parts;
}

export function buildMemoryExcerptFromHistory(
  messages: unknown[],
  maxChars: number,
): { excerpt: string; messagesProcessed: number } {
  const lines: string[] = [];
  let total = 0;
  let messagesProcessed = 0;

  for (const item of messages) {
    if (!isRecord(item)) continue;
    if (item.type === 'system' || item.subtype === 'init') continue;
    if (!isRecord(item.message)) continue;

    const role = item.message.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const parts = extractContentParts(item.message.content);
    const text = parts.join('\n').trim();
    if (!text) continue;

    const clipped = text.length > 3000 ? `${text.slice(0, 3000)}…` : text;
    const line = `[${role}]: ${clipped}`;

    if (total + line.length > maxChars) {
      const remaining = maxChars - total;
      if (remaining > 100) {
        lines.push(`${line.slice(0, remaining)}\n... (truncated)`);
        messagesProcessed++;
      }
      break;
    }

    lines.push(line);
    messagesProcessed++;
    total += line.length;
  }

  return { excerpt: lines.join('\n\n'), messagesProcessed };
}

export async function upsertMemories(opts: MemoryUpsertOpts): Promise<MemoryUpsertResult> {
  const { sessionId, projectPath, projectName, maxExcerptChars = 120_000 } = opts;
  const t0 = Date.now();

  const messages = await getPiSessionMessages(sessionId, projectPath);
  const { excerpt, messagesProcessed } = buildMemoryExcerptFromHistory(messages, maxExcerptChars);

  if (messagesProcessed === 0) {
    console.error(`${LOG} no Pi history messages found for ${sessionId}, skipping`);
    return {
      sessionId,
      messagesProcessed,
      toolCalls: { search: 0, store: 0, update: 0, delete: 0 },
      turns: 0,
      durationMs: Date.now() - t0,
    };
  }

  console.error(
    `${LOG} built Pi history excerpt for ${sessionId}: ${messagesProcessed} messages, ${excerpt.length} chars, project=${projectName}`,
  );
  console.error(`${LOG} automatic Pi memory agent upsert is temporarily skipped; returning zero tool counters`);

  return {
    sessionId,
    messagesProcessed,
    toolCalls: { search: 0, store: 0, update: 0, delete: 0 },
    turns: 0,
    durationMs: Date.now() - t0,
  };
}
