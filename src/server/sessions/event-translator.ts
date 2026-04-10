import type { SSEEvent } from './sse-parser';

export interface TranslatedMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Translate a single Anthropic SSE event into the format the frontend expects.
 * Returns null for events that should be suppressed (e.g. ping).
 */
export function translateEvent(sse: SSEEvent): TranslatedMessage | null {
  if (sse.event === 'ping') return null;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(sse.data);
  } catch {
    return null;
  }

  switch (sse.event) {
    case 'message_start':
      return {
        type: 'system',
        subtype: 'init',
        // Don't use data.message.id here — that's the Anthropic API message ID (msg_...),
        // not the CC session UUID. The real session ID is resolved post-stream via
        // meridian's /v1/sessions/:key/recover endpoint.
        session_id: null,
        model: (data.message as Record<string, unknown>)?.model,
      };

    case 'content_block_start':
    case 'content_block_delta':
    case 'content_block_stop':
    case 'message_delta':
    case 'message_stop':
      return {
        type: 'stream_event',
        event: data,
      };

    case 'error':
      return {
        type: 'error',
        message: JSON.stringify(data),
        timestamp: Date.now(),
      };

    default:
      // Forward unknown events as stream_events for forward compatibility
      return {
        type: 'stream_event',
        event: data,
      };
  }
}

/**
 * Build a result message from the accumulated stream data.
 */
export function buildResultMessage(
  cost: number,
  usage: Record<string, unknown> | null,
): TranslatedMessage {
  return {
    type: 'result',
    subtype: 'success',
    total_cost_usd: cost,
    usage,
    duration_ms: 0,
  };
}
