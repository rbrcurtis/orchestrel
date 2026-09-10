import { createHash } from 'node:crypto';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { TranscriptHistoryPage, TranscriptHistoryRequest } from '../shared/transcript-history';

const DISPLAY_PROMPT_ENTRY = 'orchestrel-display-prompt';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}


function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function getHistoryContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(content) }];

  const blocks: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: getString(block.text) ?? '' });
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', thinking: getString(block.thinking) ?? '' });
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool_use',
        id: getString(block.id),
        name: getString(block.name),
        input: isRecord(block.arguments) ? block.arguments : {},
      });
    } else {
      blocks.push({ type: 'text', text: JSON.stringify(block) });
    }
  }
  return blocks;
}

function makeUuid(sessionId: string, idx: number): string {
  if (idx < 0) return `${sessionId}-pi-history-init`;
  return `${sessionId}-pi-history-${idx}`;
}

function toHistoryMessage(message: unknown, sessionId: string, idx: number, backgroundCompaction: boolean): unknown | undefined {
  if (!isRecord(message)) return undefined;

  const timestamp = getNumber(message.timestamp);
  const uuidIndex = message.role === 'assistant' ? idx + 1 : idx;
  const base = {
    uuid: makeUuid(sessionId, uuidIndex),
    session_id: sessionId,
    parent_tool_use_id: null,
    timestamp,
  };

  if (message.role === 'user') {
    return {
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: message.content,
      },
    };
  }

  if (message.role === 'assistant') {
    return {
      ...base,
      type: 'assistant',
      message: {
        role: 'assistant',
        model: getString(message.responseModel) ?? getString(message.model) ?? '',
        content: getHistoryContentBlocks(message.content),
        stop_reason: getString(message.stopReason),
        usage: message.usage,
      },
    };
  }

  if (message.role === 'compactionSummary') {
    // Pi splices compactions into the context as role 'compactionSummary' — map to
    // the same compact_boundary system event the live stream emits.
    return {
      ...base,
      type: 'system',
      subtype: 'compact_boundary',
      ...(backgroundCompaction ? { source: 'orchestrel-bgc' } : {}),
    };
  }

  if (message.role === 'toolResult') {
    return {
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: getString(message.toolCallId) ?? '',
          content: message.content,
          is_error: message.isError === true,
        }],
      },
    };
  }

  return undefined;
}

function getContextModel(ctx: Record<string, unknown>): string | undefined {
  const model = ctx.model;
  if (typeof model === 'string') return model;
  if (!isRecord(model)) return undefined;
  return getString(model.modelId) ?? getString(model.id) ?? getString(model.name);
}

function displayPrompt(entry: SessionEntry): { displayText: string; expandedHash: string } | undefined {
  if (entry.type !== 'custom' || entry.customType !== DISPLAY_PROMPT_ENTRY || !isRecord(entry.data)) return undefined;
  const displayText = getString(entry.data.displayText);
  const expandedHash = getString(entry.data.expandedHash);
  return displayText && expandedHash ? { displayText, expandedHash } : undefined;
}

function messageText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== 'user') return undefined;
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .map((block) => isRecord(block) && block.type === 'text' ? getString(block.text) ?? '' : '')
    .join('');
  return text || undefined;
}

function collapseLegacySkillBlocks(text: string): string {
  return text.replace(
    /<skill name="([a-z0-9-]+)"[^>]*>[\s\S]*?<\/skill>/g,
    (_block, name: string) => `/${name}`,
  );
}

function getMessagesFromManager(manager: {
  buildSessionContext(): unknown;
  getBranch(): SessionEntry[];
}, sessionId: string): unknown[] {
  const ctx = manager.buildSessionContext();
  if (!isRecord(ctx) || !Array.isArray(ctx.messages)) return [];

  const branch = manager.getBranch();
  let backgroundCompaction = false;
  for (const entry of branch) {
    if (entry.type === 'compaction') backgroundCompaction = entry.fromHook === true;
  }
  const replacements = new Map<string, string[]>();
  for (const entry of branch) {
    const replacement = displayPrompt(entry);
    if (!replacement) continue;
    const texts = replacements.get(replacement.expandedHash) ?? [];
    texts.push(replacement.displayText);
    replacements.set(replacement.expandedHash, texts);
  }
  const messages: unknown[] = [];
  const model = getContextModel(ctx);
  if (model) {
    messages.push({
      type: 'system',
      subtype: 'init',
      uuid: makeUuid(sessionId, -1),
      session_id: sessionId,
      parent_tool_use_id: null,
      model,
      thinking_level: getString(ctx.thinkingLevel),
    });
  }

  for (const [idx, message] of ctx.messages.entries()) {
    let displayMessage = message;
    const text = messageText(message);
    if (text) {
      const hash = createHash('sha256').update(text).digest('hex');
      const displayTexts = replacements.get(hash);
      const displayText = displayTexts?.shift() ?? collapseLegacySkillBlocks(text);
      if (displayText !== text) displayMessage = { ...(message as Record<string, unknown>), content: displayText };
    }
    const historyMessage = toHistoryMessage(displayMessage, sessionId, idx, backgroundCompaction);
    if (historyMessage !== undefined) messages.push(historyMessage);
  }

  return messages;
}

function getSessionPaths(sessions: unknown[], sessionId: string): string[] {
  const paths: string[] = [];
  for (const session of sessions) {
    if (!isRecord(session)) continue;
    if (session.id !== sessionId) continue;
    if (typeof session.path === 'string') paths.push(session.path);
  }
  return paths;
}

export async function getPiSessionHistoryPage(
  sessionId: string,
  cwd: string,
  request: TranscriptHistoryRequest,
): Promise<TranscriptHistoryPage> {
  const { SessionManager, sessionEntryToContextMessages } = await import('@earendil-works/pi-coding-agent');
  const paths = getSessionPaths(await SessionManager.list(cwd), sessionId);
  if (paths.length !== 1) throw new Error(`Expected one history source for ${sessionId}, found ${paths.length}`);
  const manager = SessionManager.open(paths[0], undefined, cwd);
  const entries = manager.buildContextEntries();
  const records: TranscriptHistoryPage['records'] = [];
  const ctx = manager.buildSessionContext();
  const model = getContextModel(ctx as unknown as Record<string, unknown>);
  if (model) records.push({ id: `${sessionId}:init`, message: {
    type: 'system', subtype: 'init', model, session_id: sessionId,
  } });
  const replacements = new Map<string, string[]>();
  for (const entry of manager.getBranch()) {
    const replacement = displayPrompt(entry);
    if (!replacement) continue;
    const texts = replacements.get(replacement.expandedHash) ?? [];
    texts.push(replacement.displayText);
    replacements.set(replacement.expandedHash, texts);
  }
  for (const entry of entries) {
    const messages = sessionEntryToContextMessages(entry);
    for (const [part, message] of messages.entries()) {
      const id = `${entry.id}:${part}`;
      const text = messageText(message);
      const hash = text ? createHash('sha256').update(text).digest('hex') : undefined;
      const displayText = hash ? replacements.get(hash)?.shift() ?? collapseLegacySkillBlocks(text!) : undefined;
      const displayed = displayText !== undefined ? { ...message, content: displayText } : message;
      const mapped = toHistoryMessage(displayed, sessionId, part, entry.type === 'compaction' && entry.fromHook === true);
      if (isRecord(mapped)) records.push({ id, message: { ...mapped, uuid: id } });
    }
  }
  const revision = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  let start = 0;
  let end = records.length;
  let reset = false;
  if (request.before) {
    const i = records.findIndex((record) => record.id === request.before);
    if (request.revision !== revision || i < 0) reset = true;
    else end = i;
  }
  if (request.after) {
    const i = records.findIndex((record) => record.id === request.after);
    const prefix = createHash('sha256').update(JSON.stringify(records.slice(0, i + 1))).digest('hex');
    if (i < 0 || (request.anchorOnly ? request.revision !== revision : request.prefix !== prefix)) reset = true;
    else start = i + 1;
  }
  if (reset) { start = 0; end = records.length; }
  const page: TranscriptHistoryPage['records'] = [];
  let bytes = 0;
  const forward = !!request.after && !reset;
  if (forward) {
    for (let i = start; i < end && page.length < 120; i++) {
      const size = Buffer.byteLength(JSON.stringify(records[i]));
      if (page.length && bytes + size > 1_048_576) break;
      page.push(records[i]); bytes += size;
    }
    end = start + page.length;
  } else {
    for (let i = end - 1; i >= start && page.length < 120; i--) {
      const size = Buffer.byteLength(JSON.stringify(records[i]));
      if (page.length && bytes + size > 1_048_576) break;
      page.unshift(records[i]); bytes += size;
    }
    start = end - page.length;
  }
  return {
    sessionId, revision, records: page,
    before: page[0]?.id ?? null, after: page.at(-1)?.id ?? null,
    prefix: createHash('sha256').update(JSON.stringify(records.slice(0, end))).digest('hex'),
    hasOlder: start > 0, hasNewer: end < records.length, reset,
  };
}

export async function getPiSessionMessages(sessionId: string, cwd: string): Promise<unknown[]> {
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');

    const sessions = await SessionManager.list(cwd);
    const sessionPaths = getSessionPaths(sessions, sessionId);
    const messages: unknown[] = [];
    for (const sessionPath of sessionPaths.reverse()) {
      const manager = SessionManager.open(sessionPath, undefined, cwd);
      messages.push(...getMessagesFromManager(manager, sessionId));
    }
    return messages;
  } catch {
    return [];
  }
}
