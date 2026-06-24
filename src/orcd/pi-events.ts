/* oxlint-disable orchestrel/log-before-early-return -- pure boundary mapper uses guard returns without session context */
import type { TaskNotificationEvent, TaskProgressEvent, TaskStartedEvent } from './async-task-tracker';

export interface ContextUsage {
  contextTokens: number;
  contextWindow: number;
}

/** Name of the LLM-callable tool the pi-subagents extension registers. */
const SUBAGENT_TOOL_NAME = 'Agent';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Human-readable "what is the subagent doing right now" line from the extension's
 * AgentDetails (carried on tool_execution_update.partialResult). Prefer the live
 * `activity` ("finding files", "running command", …); fall back to status.
 */
function subagentProgressText(partial: unknown): string {
  if (!isRecord(partial)) return '';
  const activity = typeof partial.activity === 'string' ? partial.activity.trim() : '';
  if (activity) return activity;
  const status = typeof partial.status === 'string' ? partial.status.trim() : '';
  return status;
}

/**
 * Map a Pi `Agent` tool execution event (from the pi-subagents extension) into the
 * harness-neutral subagent task events the UI already renders (SubagentFeed). The
 * tool call id doubles as the task id, so this converges with the blocking-subagent
 * line item the UI creates from the `Agent` tool_use block (same key).
 *
 * tool_execution_* fire for every tool, so non-`Agent` events return null. Returns
 * null for updates with no activity text — the caller additionally dedupes
 * unchanged progress so spinner-only frames don't flood the stream.
 */
export function mapSubagentExecEvent(
  event: unknown,
): TaskStartedEvent | TaskProgressEvent | TaskNotificationEvent | null {
  if (!isRecord(event)) return null;
  if (event.toolName !== SUBAGENT_TOOL_NAME) return null;
  const taskId = event.toolCallId;
  if (typeof taskId !== 'string') return null;

  if (event.type === 'tool_execution_start') {
    const args = isRecord(event.args) ? event.args : {};
    const description =
      typeof args.description === 'string' && args.description.trim() ? args.description.trim() : 'Subagent';
    return { type: 'task_started', task_id: taskId, description };
  }

  if (event.type === 'tool_execution_update') {
    const data = subagentProgressText(event.partialResult);
    if (!data) return null;
    return { type: 'task_progress', task_id: taskId, data };
  }

  if (event.type === 'tool_execution_end') {
    return { type: 'task_notification', task_id: taskId, status: event.isError === true ? 'failed' : 'completed' };
  }

  return null;
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

  // A turn whose assistant message stopped with an error still arrives as
  // turn_end — reflect that as an error result (with the provider's message)
  // instead of silently rendering "Turn complete" in the UI.
  const message = event.message;
  const stopReason = isRecord(message) ? message.stopReason : undefined;
  const errorMessage =
    isRecord(message) && typeof message.errorMessage === 'string' ? message.errorMessage : undefined;
  const subtype = stopReason === 'error' ? 'error_during_execution' : 'success';

  return {
    type: 'result',
    subtype,
    message: event.message,
    toolResults,
    ...(errorMessage ? { errorMessage } : {}),
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
