interface AgentSdkApiRetryMessage {
  type: 'system';
  subtype: 'api_retry';
  attempt?: unknown;
  max_retries?: unknown;
  retry_delay_ms?: unknown;
  error_status?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isAgentSdkApiRetryMessage(value: unknown): value is AgentSdkApiRetryMessage {
  return isRecord(value) && value.type === 'system' && value.subtype === 'api_retry';
}

export function formatAgentSdkApiRetryError(msg: AgentSdkApiRetryMessage): string {
  const status = typeof msg.error_status === 'number'
    ? `HTTP ${msg.error_status}`
    : 'connection error';
  const error = typeof msg.error === 'string' && msg.error.trim()
    ? msg.error.trim()
    : 'retryable provider error';

  return `Provider request failed (${status}: ${error}). orcd does not retry provider or cloud service errors.`;
}

export function closeAndThrowOnAgentSdkRetry(event: unknown, close: () => void): void {
  if (!isAgentSdkApiRetryMessage(event)) return;
  close();
  throw new Error(formatAgentSdkApiRetryError(event));
}
