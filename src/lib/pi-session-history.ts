import { createHash } from 'node:crypto';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

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

function toHistoryMessage(message: unknown, sessionId: string, idx: number): unknown | undefined {
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

function legacySkillInvocation(text: string): string | undefined {
  const match = text.match(/^<skill name="([a-z0-9-]+)"[^>]*>[\s\S]*<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return undefined;
  const args = match[2]?.trim();
  return args ? `/${match[1]}(${args})` : `/${match[1]}`;
}

function getMessagesFromManager(manager: {
  buildSessionContext(): unknown;
  getBranch(): SessionEntry[];
}, sessionId: string): unknown[] {
  const ctx = manager.buildSessionContext();
  if (!isRecord(ctx) || !Array.isArray(ctx.messages)) return [];

  const replacements = new Map<string, string[]>();
  for (const entry of manager.getBranch()) {
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
      const displayText = displayTexts?.shift() ?? legacySkillInvocation(text);
      if (displayText) displayMessage = { ...(message as Record<string, unknown>), content: displayText };
    }
    const historyMessage = toHistoryMessage(displayMessage, sessionId, idx);
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
