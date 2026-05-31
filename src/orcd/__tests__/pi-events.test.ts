import { describe, expect, it } from 'vitest';
import { getContextUsageFromPiEvent, mapPiEventToOrcdPayload } from '../pi-events';

describe('pi event boundary mapper', () => {
  it('passes ordinary Pi events through unchanged', () => {
    const event = {
      type: 'message_update',
      message: { id: 'msg-1', text: 'hello' },
    };

    expect(mapPiEventToOrcdPayload(event)).toBe(event);
  });

  it('maps turn_end to result-like payload', () => {
    const event = {
      type: 'turn_end',
      message: { id: 'msg-2', text: 'done' },
      toolResults: [{ id: 'tool-1', ok: true }],
    };

    expect(mapPiEventToOrcdPayload(event)).toEqual({
      type: 'result',
      subtype: 'success',
      message: event.message,
      toolResults: event.toolResults,
    });
  });

  it('maps turn_end with missing toolResults to empty array', () => {
    const event = {
      type: 'turn_end',
      message: { id: 'msg-3', text: 'done' },
    };

    expect(mapPiEventToOrcdPayload(event)).toEqual({
      type: 'result',
      subtype: 'success',
      message: event.message,
      toolResults: [],
    });
  });

  it('returns null from getContextUsageFromPiEvent when usage is absent', () => {
    expect(getContextUsageFromPiEvent({ type: 'message_update', message: {} })).toBeNull();
    expect(getContextUsageFromPiEvent({ type: 'message_update' })).toBeNull();
    expect(getContextUsageFromPiEvent(null)).toBeNull();
  });

  it('extracts context usage from camelCase usage fields', () => {
    const event = {
      type: 'turn_end',
      message: {
        usage: {
          inputTokens: 123,
          contextWindow: 200000,
        },
      },
    };

    expect(getContextUsageFromPiEvent(event)).toEqual({
      contextTokens: 123,
      contextWindow: 200000,
    });
  });

  it('extracts context usage from snake_case usage fields', () => {
    const event = {
      type: 'turn_end',
      message: {
        usage: {
          input_tokens: 456,
          context_window: 262144,
        },
      },
    };

    expect(getContextUsageFromPiEvent(event)).toEqual({
      contextTokens: 456,
      contextWindow: 262144,
    });
  });
});
