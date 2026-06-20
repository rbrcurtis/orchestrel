export interface AgentSdkApiRetryMessage {
  type: 'system';
  subtype: 'api_retry';
  attempt?: unknown;
  max_retries?: unknown;
  retry_delay_ms?: unknown;
  error_status?: unknown;
  error?: unknown;
}

export interface AgentSdkApiRetryLogContext {
  sessionId: string;
  provider: string;
  model: string;
  cwd: string;
  baseUrl?: string;
  hasApiKey: boolean;
  hasAuthToken: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function shouldRedact(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes('api_key') || k.includes('apikey') || k.includes('auth') || k.includes('token') || k.includes('secret');
}

function normalizeUnknown(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();

  if (value instanceof Error) {
    const normalized: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    if (value.stack) normalized.stack = value.stack;
    if ('cause' in value) normalized.cause = normalizeUnknown(value.cause, seen);
    return normalized;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => normalizeUnknown(item, seen));
  }

  if (isRecord(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      normalized[key] = shouldRedact(key) ? '[REDACTED]' : normalizeUnknown(item, seen);
    }
    return normalized;
  }

  return String(value);
}

function stringifyUnknown(value: unknown): string {
  return JSON.stringify(normalizeUnknown(value));
}

function summarizeRetryError(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  if (typeof error === 'undefined' || error === null) return 'retryable provider error';
  return stringifyUnknown(error);
}

export function isAgentSdkApiRetryMessage(value: unknown): value is AgentSdkApiRetryMessage {
  return isRecord(value) && value.type === 'system' && value.subtype === 'api_retry';
}

export function formatAgentSdkApiRetryError(msg: AgentSdkApiRetryMessage): string {
  const status = typeof msg.error_status === 'number'
    ? `HTTP ${msg.error_status}`
    : 'connection error';
  return `Provider request failed (${status}: ${summarizeRetryError(msg.error)}).`;
}

export function formatAgentSdkApiRetryLog(msg: AgentSdkApiRetryMessage, context: AgentSdkApiRetryLogContext): string {
  return JSON.stringify({
    context,
    retry: normalizeUnknown(msg),
  });
}

export function shouldAllowAgentSdkRetry(msg: AgentSdkApiRetryMessage): boolean {
  return typeof msg.error_status === 'number' && msg.error_status >= 500;
}

export function closeAndThrowOnAgentSdkRetry(
  event: unknown,
  close: () => void,
  logRetry?: (msg: AgentSdkApiRetryMessage) => void,
): void {
  if (!isAgentSdkApiRetryMessage(event)) return;
  logRetry?.(event);
  if (shouldAllowAgentSdkRetry(event)) return;
  close();
  throw new Error(formatAgentSdkApiRetryError(event));
}
