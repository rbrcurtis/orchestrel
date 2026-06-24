import { describe, expect, it } from 'vitest';
import { getContextUsageFromPiEvent, mapPiEventToOrcdPayload, mapSubagentExecEvent } from '../pi-events';

describe('pi event boundary mapper', () => {
  it('passes unsupported ordinary Pi events through unchanged', () => {
    const event = {
      type: 'agent_start',
    };

    expect(mapPiEventToOrcdPayload(event)).toBe(event);
  });

  it('maps Pi assistant text updates to Claude-shaped stream events', () => {
    expect(mapPiEventToOrcdPayload({
      type: 'message_start',
      message: { role: 'assistant', content: [] },
    })).toEqual({
      type: 'message_start',
      message: { role: 'assistant', content: [] },
    });
    expect(mapPiEventToOrcdPayload({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    })).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    expect(mapPiEventToOrcdPayload({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
    })).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    });
    expect(mapPiEventToOrcdPayload({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0 },
    })).toEqual({ type: 'content_block_stop', index: 0 });
    expect(mapPiEventToOrcdPayload({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })).toEqual({ type: 'message_stop' });
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

  it('maps an errored turn_end to an error result carrying the provider message', () => {
    const event = {
      type: 'turn_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'out of extra usage' },
      toolResults: [],
    };

    expect(mapPiEventToOrcdPayload(event)).toEqual({
      type: 'result',
      subtype: 'error_during_execution',
      message: event.message,
      toolResults: [],
      errorMessage: 'out of extra usage',
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

describe('subagent tool_execution mapper', () => {
  it('ignores tool_execution events for non-Agent tools', () => {
    expect(mapSubagentExecEvent({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 't1', args: {} })).toBeNull();
    expect(mapSubagentExecEvent({ type: 'tool_execution_end', toolName: 'read', toolCallId: 't1', isError: false })).toBeNull();
  });

  it('maps Agent start to task_started using the tool description', () => {
    expect(
      mapSubagentExecEvent({ type: 'tool_execution_start', toolName: 'Agent', toolCallId: 'call-1', args: { description: 'Explore repo' } }),
    ).toEqual({ type: 'task_started', task_id: 'call-1', description: 'Explore repo' });
  });

  it('falls back to a generic description when the Agent call omits one', () => {
    expect(
      mapSubagentExecEvent({ type: 'tool_execution_start', toolName: 'Agent', toolCallId: 'call-1', args: {} }),
    ).toEqual({ type: 'task_started', task_id: 'call-1', description: 'Subagent' });
  });

  it('maps Agent updates to task_progress preferring live activity over status', () => {
    expect(
      mapSubagentExecEvent({ type: 'tool_execution_update', toolName: 'Agent', toolCallId: 'call-1', partialResult: { activity: 'finding files', status: 'running' } }),
    ).toEqual({ type: 'task_progress', task_id: 'call-1', data: 'finding files' });
    expect(
      mapSubagentExecEvent({ type: 'tool_execution_update', toolName: 'Agent', toolCallId: 'call-1', partialResult: { status: 'running' } }),
    ).toEqual({ type: 'task_progress', task_id: 'call-1', data: 'running' });
  });

  it('returns null for an Agent update with no activity or status (caller drops it)', () => {
    expect(
      mapSubagentExecEvent({ type: 'tool_execution_update', toolName: 'Agent', toolCallId: 'call-1', partialResult: {} }),
    ).toBeNull();
  });

  it('maps Agent end to task_notification, reflecting the error flag', () => {
    expect(
      mapSubagentExecEvent({ type: 'tool_execution_end', toolName: 'Agent', toolCallId: 'call-1', isError: false }),
    ).toEqual({ type: 'task_notification', task_id: 'call-1', status: 'completed' });
    expect(
      mapSubagentExecEvent({ type: 'tool_execution_end', toolName: 'Agent', toolCallId: 'call-1', isError: true }),
    ).toEqual({ type: 'task_notification', task_id: 'call-1', status: 'failed' });
  });
});
