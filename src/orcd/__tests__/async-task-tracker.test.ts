import { describe, expect, it } from 'vitest';
import {
  AsyncTaskTracker,
  extractSubagentCompletions,
  extractSubagentLaunches,
} from '../async-task-tracker';

// Fixtures mirror pi-subagents' actual structured events: the Agent tool's
// tool_execution_end details (AgentDetails) and the subagent-notification
// custom message details (NotificationDetails).

function launchToolEnd(agentId: string, description: string, status: 'background' | 'queued' = 'background'): unknown {
  return {
    type: 'tool_execution_end',
    toolCallId: 'call_abc',
    toolName: 'Agent',
    result: {
      content: [{ type: 'text', text: `Agent started in background.\nAgent ID: ${agentId}\n…` }],
      details: {
        displayName: 'Explore',
        description,
        subagentType: 'Explore',
        toolUses: 0,
        tokens: '',
        durationMs: 0,
        status,
        agentId,
      },
    },
  };
}

function notificationMessage(
  entries: Array<{ id: string; status: string; resultPreview?: string }>,
  type: 'message_start' | 'message_end' = 'message_start',
): unknown {
  const [first, ...others] = entries;
  return {
    type,
    message: {
      role: 'custom',
      customType: 'subagent-notification',
      content: '<task-notification>…</task-notification>',
      display: true,
      details: {
        ...first,
        description: 'desc',
        toolUses: 3,
        turnCount: 1,
        totalTokens: 100,
        durationMs: 5000,
        ...(others.length ? { others: others.map((o) => ({ ...o, description: 'desc', toolUses: 0, turnCount: 0, totalTokens: 0, durationMs: 0 })) } : {}),
      },
    },
  };
}

describe('extractSubagentLaunches', () => {
  it('extracts a background launch from Agent tool_execution_end details', () => {
    expect(extractSubagentLaunches(launchToolEnd('agent-123', 'Explore repo'))).toEqual([
      { taskId: 'agent-123', description: 'Explore repo' },
    ]);
  });

  it('extracts a queued launch', () => {
    expect(extractSubagentLaunches(launchToolEnd('agent-q', 'Queued work', 'queued'))).toEqual([
      { taskId: 'agent-q', description: 'Queued work' },
    ]);
  });

  it('ignores foreground Agent completions (terminal status, no background)', () => {
    const event = {
      type: 'tool_execution_end',
      toolCallId: 'call_fg',
      toolName: 'Agent',
      result: {
        content: [{ type: 'text', text: 'DONE' }],
        details: { displayName: 'Explore', description: 'fg', subagentType: 'Explore', toolUses: 4, tokens: '1k', durationMs: 100, status: 'completed', agentId: 'agent-fg' },
      },
    };
    expect(extractSubagentLaunches(event)).toEqual([]);
  });

  it('ignores tool results without structured details (plain text tools)', () => {
    const event = {
      type: 'tool_execution_end',
      toolCallId: 'call_bash',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'Agent started in background.\nAgent ID: fake' }] },
    };
    expect(extractSubagentLaunches(event)).toEqual([]);
  });
});

describe('extractSubagentCompletions', () => {
  it('extracts completion from a subagent-notification custom message', () => {
    expect(extractSubagentCompletions(notificationMessage([{ id: 'agent-123', status: 'completed', resultPreview: 'DONE' }]))).toEqual([
      { taskId: 'agent-123', status: 'completed', result: 'DONE' },
    ]);
  });

  it('extracts every agent in a grouped notification via others[]', () => {
    expect(extractSubagentCompletions(notificationMessage([
      { id: 'agent-1', status: 'completed' },
      { id: 'agent-2', status: 'error' },
    ]))).toEqual([
      { taskId: 'agent-1', status: 'completed' },
      { taskId: 'agent-2', status: 'failed' },
    ]);
  });

  it('maps terminal statuses: steered→completed, aborted/stopped/error→failed', () => {
    for (const [status, expected] of [
      ['steered', 'completed'],
      ['aborted', 'failed'],
      ['stopped', 'failed'],
      ['error', 'failed'],
    ] as const) {
      expect(extractSubagentCompletions(notificationMessage([{ id: 'a', status }]))[0]?.status).toBe(expected);
    }
  });

  it('ignores non-terminal statuses (running, queued, background)', () => {
    for (const status of ['running', 'queued', 'background']) {
      expect(extractSubagentCompletions(notificationMessage([{ id: 'a', status }]))).toEqual([]);
    }
  });

  it('extracts completion from get_subagent_result tool_execution_end details', () => {
    const event = {
      type: 'tool_execution_end',
      toolCallId: 'call_get',
      toolName: 'get_subagent_result',
      result: {
        content: [{ type: 'text', text: 'Agent: agent-123 …' }],
        details: { agentId: 'agent-123', status: 'completed' },
      },
    };
    expect(extractSubagentCompletions(event)).toEqual([{ taskId: 'agent-123', status: 'completed' }]);
  });

  it('ignores unrelated custom messages and events', () => {
    expect(extractSubagentCompletions({ type: 'message_start', message: { role: 'custom', customType: 'other', details: { id: 'a', status: 'completed' } } })).toEqual([]);
    expect(extractSubagentCompletions({ type: 'turn_end' })).toEqual([]);
    expect(extractSubagentCompletions('Continue')).toEqual([]);
  });
});

describe('AsyncTaskTracker', () => {
  it('tracks pending tasks and resolves them once', () => {
    const tracker = new AsyncTaskTracker();

    const started = tracker.recordLaunch({ taskId: 'agent-123', description: 'Implement remaining tasks' });

    expect(started).toEqual({
      type: 'task_started',
      task_id: 'agent-123',
      description: 'Implement remaining tasks',
    });
    expect(tracker.hasPending()).toBe(true);

    const notification = tracker.recordNotification({ taskId: 'agent-123', status: 'completed', result: 'DONE' });

    expect(notification).toEqual({
      type: 'task_notification',
      task_id: 'agent-123',
      status: 'completed',
      result: 'DONE',
    });
    expect(tracker.hasPending()).toBe(false);
    // Duplicate notifications (message_start + message_end both fire) are idempotent.
    expect(tracker.recordNotification({ taskId: 'agent-123', status: 'completed' })).toBeNull();
  });

  it('ignores completions for unknown task ids (foreground agents)', () => {
    const tracker = new AsyncTaskTracker();
    expect(tracker.recordNotification({ taskId: 'never-launched', status: 'completed' })).toBeNull();
    expect(tracker.hasPending()).toBe(false);
  });
});
