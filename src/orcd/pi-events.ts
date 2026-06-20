/* oxlint-disable orchestrel/log-before-early-return -- pure boundary mapper uses guard returns without session context */
export interface ContextUsage {
  contextTokens: number;
  contextWindow: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readUsageNumber(usage: Record<string, unknown>, camelKey: string, snakeKey: string): number | null {
  const camel = usage[camelKey];
  if (typeof camel === 'number' && Number.isFinite(camel)) return camel;

  const snake = usage[snakeKey];
  if (typeof snake === 'number' && Number.isFinite(snake)) return snake;

  return null;
}

export function mapPiEventToOrcdPayload(event: unknown): unknown {
  if (!isRecord(event)) return event;

  if (event.type === 'message_start') {
    const message = event.message;
    if (!isRecord(message) || message.role !== 'assistant') return event;
    return { type: 'message_start', message };
  }

  if (event.type === 'message_end') {
    const message = event.message;
    if (!isRecord(message) || message.role !== 'assistant') return event;
    return { type: 'message_stop' };
  }

  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent;
    if (!isRecord(update)) return event;

    const index = typeof update.contentIndex === 'number' ? update.contentIndex : 0;
    if (update.type === 'text_start') return { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
    if (update.type === 'text_delta' && typeof update.delta === 'string') {
      return { type: 'content_block_delta', index, delta: { type: 'text_delta', text: update.delta } };
    }
    if (update.type === 'text_end') return { type: 'content_block_stop', index };

    if (update.type === 'thinking_start') return { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } };
    if (update.type === 'thinking_delta' && typeof update.delta === 'string') {
      return { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: update.delta } };
    }
    if (update.type === 'thinking_end') return { type: 'content_block_stop', index };

    if (update.type === 'toolcall_start') {
      const partial = update.partial;
      const content = isRecord(partial) && Array.isArray(partial.content) ? partial.content[index] : undefined;
      const block = isRecord(content) ? content : {};
      return {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
        },
      };
    }
    if (update.type === 'toolcall_delta' && typeof update.delta === 'string') {
      return { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: update.delta } };
    }
    if (update.type === 'toolcall_end') return { type: 'content_block_stop', index };

    return event;
  }

  if (event.type !== 'turn_end') return event;

  const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];

  return {
    type: 'result',
    subtype: 'success',
    message: event.message,
    toolResults,
  };
}

export function getContextUsageFromPiEvent(event: unknown): ContextUsage | null {
  if (!isRecord(event)) return null;

  const message = event.message;
  if (!isRecord(message)) return null;

  const usage = message.usage;
  if (!isRecord(usage)) return null;

  const contextTokens = readUsageNumber(usage, 'inputTokens', 'input_tokens');
  const contextWindow = readUsageNumber(usage, 'contextWindow', 'context_window');
  if (contextTokens === null || contextWindow === null) return null;

  return { contextTokens, contextWindow };
}
