function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
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
  const base = {
    uuid: makeUuid(sessionId, idx),
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

function getMessagesFromContext(ctx: unknown, sessionId: string): unknown[] {
  if (!isRecord(ctx) || !Array.isArray(ctx.messages)) return [];

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
    const historyMessage = toHistoryMessage(message, sessionId, idx);
    if (historyMessage !== undefined) messages.push(historyMessage);
  }

  return messages;
}

function getSessionPath(sessions: unknown[], sessionId: string): string | undefined {
  for (const session of sessions) {
    if (!isRecord(session)) continue;
    if (session.id !== sessionId) continue;
    return typeof session.path === 'string' ? session.path : undefined;
  }
  return undefined;
}

export async function getPiSessionMessages(sessionId: string, cwd: string): Promise<unknown[]> {
  try {
    const pi = await import('@earendil-works/pi-coding-agent');
    const piExports: Record<string, unknown> = pi;

    const getAgentDir = piExports.getAgentDir;
    const getDefaultSessionDir = piExports.getDefaultSessionDir;
    const sessionManager = piExports.SessionManager;
    if (!isFunction(getAgentDir) || !isRecord(sessionManager)) return [];

    const listSessions = sessionManager.list;
    const openSession = sessionManager.open;
    if (!isFunction(listSessions) || !isFunction(openSession)) return [];

    const agentDir = getAgentDir();
    if (typeof agentDir !== 'string') return [];

    let sessionDir: string | undefined;
    if (isFunction(getDefaultSessionDir)) {
      const dir = getDefaultSessionDir(cwd, agentDir);
      if (typeof dir !== 'string') return [];
      sessionDir = dir;
    }

    const sessions = await listSessions(cwd, sessionDir);
    if (!Array.isArray(sessions)) return [];

    const sessionPath = getSessionPath(sessions, sessionId);
    if (!sessionPath) return [];

    const manager = openSession(sessionPath, sessionDir, cwd);
    if (!isRecord(manager)) return [];

    const buildSessionContext = manager.buildSessionContext;
    if (!isFunction(buildSessionContext)) return [];

    return getMessagesFromContext(buildSessionContext.call(manager), sessionId);
  } catch {
    return [];
  }
}
