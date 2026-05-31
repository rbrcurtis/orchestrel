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
  if (!isRecord(event) || event.type !== 'turn_end') return event;

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
