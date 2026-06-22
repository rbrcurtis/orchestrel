const CHARS_PER_TOKEN = 3.5;

export interface CompactResult {
  sessionId: string;
  messagesBefore: number;
  messagesCovered: number;
  summaryTokens: number;
  summaryChars: number;
  durationMs: number;
}

export interface CompactOpts {
  sessionId: string;
  projectPath: string;
  model: string;
  env?: Record<string, string>;
  contextWindow?: number;
  ratio?: number;
  maxExcerptChars?: number;
  dryRun?: boolean;
}

export interface IndexedMessage {
  lineIndex: number;
  role: 'user' | 'assistant';
  text: string;
  isToolResult: boolean;
  isToolUse: boolean;
}

export interface PreparedCompaction {
  sessionId: string;
  messagesBefore: number;
  messagesCovered: number;
  summaryChars: number;
  prepareDurationMs: number;
  compact: () => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown, key: string, fallback: number): number {
  if (!isRecord(value)) return fallback;
  const n = value[key];
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

export function parseLines(lines: string[]): { lastBoundaryLine: number; messages: IndexedMessage[] } {
  let lastBoundaryLine = -1;
  const messages: IndexedMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      lastBoundaryLine = i;
      messages.length = 0;
      continue;
    }

    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    if (!isRecord(obj.message)) continue;

    const role = obj.message.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const content = obj.message.content;
    const text = extractText(content);
    if (!text.trim()) continue;

    const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
    messages.push({
      lineIndex: i,
      role,
      text,
      isToolResult: blocks.some((b) => b.type === 'tool_result'),
      isToolUse: blocks.some((b) => b.type === 'tool_use'),
    });
  }

  return { lastBoundaryLine, messages };
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(`[tool: ${block.name}]`);
    }
    if (block.type === 'tool_result') {
      const c = block.content;
      if (typeof c === 'string') {
        parts.push(`[tool result: ${c.slice(0, 500)}]`);
      } else if (Array.isArray(c)) {
        for (const item of c) {
          if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
            parts.push(`[tool result: ${item.text.slice(0, 500)}]`);
          }
        }
      }
    }
  }

  return parts.join('\n');
}

export function buildExcerpt(msgs: IndexedMessage[], maxChars: number): string {
  const parts: string[] = [];
  let total = 0;

  for (const msg of msgs) {
    const text = msg.text.length > 3000 ? msg.text.slice(0, 3000) : msg.text;
    const line = `[${msg.role}]: ${text}`;

    if (total + line.length > maxChars) {
      const remaining = maxChars - total;
      if (remaining > 100) parts.push(`${line.slice(0, remaining)}\n... (truncated)`);
      break;
    }

    parts.push(line);
    total += line.length;
  }

  return parts.join('\n\n');
}

export async function applyCompaction(prepared: PreparedCompaction): Promise<CompactResult> {
  const t0 = Date.now();
  const result = await prepared.compact();
  const summaryChars = readNumber(result, 'summaryChars', prepared.summaryChars);

  return {
    sessionId: prepared.sessionId,
    messagesBefore: readNumber(result, 'messagesBefore', prepared.messagesBefore),
    messagesCovered: readNumber(result, 'messagesCovered', prepared.messagesCovered),
    summaryTokens: readNumber(result, 'summaryTokens', Math.ceil(summaryChars / CHARS_PER_TOKEN)),
    summaryChars,
    durationMs: readNumber(result, 'durationMs', Date.now() - t0),
  };
}

export async function compactSession(_opts: CompactOpts): Promise<CompactResult> {
  throw new Error('Offline session compaction has been removed; compact active Pi sessions through orcd');
}
