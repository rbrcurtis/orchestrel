import { describe, expect, it } from 'vitest';
import {
  AsyncTaskTracker,
  extractBackgroundTaskLaunches,
  parseAsyncAgentLaunch,
  parseSdkTaskNotification,
  parseTaskNotification,
} from '../async-task-tracker';

describe('parseAsyncAgentLaunch', () => {
  it('extracts async Agent launch details from tool result text', () => {
    const text = [
      'Async agent launched successfully.',
      'agentId: agent-123 (internal ID - do not mention to user. Use SendMessage with to: \'agent-123\' to continue this agent.)',
      'The agent is working in the background. You will be notified automatically when it completes.',
      'output_file: /tmp/claude/tasks/agent-123.output',
    ].join('\n');

    expect(parseAsyncAgentLaunch(text, 'call_abc', 'Implement remaining tasks')).toEqual({
      taskId: 'agent-123',
      toolUseId: 'call_abc',
      description: 'Implement remaining tasks',
      outputFile: '/tmp/claude/tasks/agent-123.output',
    });
  });

  it('returns null for foreground Agent tool results', () => {
    expect(parseAsyncAgentLaunch('DONE\nTests passed', 'call_abc', 'Review')).toBeNull();
  });
});

describe('parseTaskNotification', () => {
  it('extracts completed notification from queue-operation content', () => {
    const content = [
      '<task-notification>',
      '<task-id>agent-123</task-id>',
      '<tool-use-id>call_abc</tool-use-id>',
      '<output-file>/tmp/claude/tasks/agent-123.output</output-file>',
      '<status>completed</status>',
      '<summary>Agent "Implement remaining tasks" completed</summary>',
      '<result>DONE_WITH_CONCERNS\nTests passed</result>',
      '</task-notification>',
    ].join('\n');

    expect(parseTaskNotification(content)).toEqual({
      taskId: 'agent-123',
      toolUseId: 'call_abc',
      outputFile: '/tmp/claude/tasks/agent-123.output',
      status: 'completed',
      summary: 'Agent "Implement remaining tasks" completed',
      result: 'DONE_WITH_CONCERNS\nTests passed',
    });
  });

  it('extracts failed notification', () => {
    const content = [
      '<task-notification>',
      '<task-id>agent-123</task-id>',
      '<tool-use-id>call_abc</tool-use-id>',
      '<status>failed</status>',
      '<summary>Agent failed</summary>',
      '</task-notification>',
    ].join('\n');

    expect(parseTaskNotification(content)?.status).toBe('failed');
  });

  it('treats killed notifications as failed terminal results', () => {
    const content = [
      '<task-notification>',
      '<task-id>bv8xx4z6c</task-id>',
      '<tool-use-id>tooluse_yMsyf0cB85CRgSruDpT0Qk</tool-use-id>',
      '<output-file>/tmp/claude/tasks/bv8xx4z6c.output</output-file>',
      '<status>killed</status>',
      '<summary>Monitor "Jenkins deploy for commit 24b151f" stopped</summary>',
      '</task-notification>',
    ].join('\n');

    expect(parseTaskNotification(content)).toEqual({
      taskId: 'bv8xx4z6c',
      toolUseId: 'tooluse_yMsyf0cB85CRgSruDpT0Qk',
      outputFile: '/tmp/claude/tasks/bv8xx4z6c.output',
      status: 'failed',
      summary: 'Monitor "Jenkins deploy for commit 24b151f" stopped',
      result: 'Monitor "Jenkins deploy for commit 24b151f" stopped',
    });
  });

  it('returns null for unrelated queue content', () => {
    expect(parseTaskNotification('Continue')).toBeNull();
  });
});

describe('parseSdkTaskNotification', () => {
  it('treats SDK stopped Monitor notifications as failed terminal results', () => {
    expect(parseSdkTaskNotification({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bbqs4eouz',
      tool_use_id: 'tooluse_AP4AYp7XO6OzJSixgNTeJ8',
      status: 'stopped',
      summary: 'Monitor "Jenkins deploy for commit 24b151f" stopped',
    })).toEqual({
      taskId: 'bbqs4eouz',
      toolUseId: 'tooluse_AP4AYp7XO6OzJSixgNTeJ8',
      status: 'failed',
      summary: 'Monitor "Jenkins deploy for commit 24b151f" stopped',
      result: 'Monitor "Jenkins deploy for commit 24b151f" stopped',
    });
  });
});

describe('AsyncTaskTracker', () => {
  it('tracks pending tasks and resolves them once', () => {
    const tracker = new AsyncTaskTracker();

    const started = tracker.recordLaunch({
      taskId: 'agent-123',
      toolUseId: 'call_abc',
      description: 'Implement remaining tasks',
      outputFile: '/tmp/claude/tasks/agent-123.output',
    });

    expect(started).toEqual({
      type: 'task_started',
      task_id: 'agent-123',
      description: 'Implement remaining tasks',
    });
    expect(tracker.hasPending()).toBe(true);

    const notification = tracker.recordNotification({
      taskId: 'agent-123',
      toolUseId: 'call_abc',
      outputFile: '/tmp/claude/tasks/agent-123.output',
      status: 'completed',
      summary: 'Agent completed',
      result: 'DONE',
    });

    expect(notification).toEqual({
      type: 'task_notification',
      task_id: 'agent-123',
      status: 'completed',
      result: 'DONE',
    });
    expect(tracker.hasPending()).toBe(false);
    expect(tracker.recordNotification({
      taskId: 'agent-123',
      toolUseId: 'call_abc',
      status: 'completed',
      summary: 'Agent completed',
    })).toBeNull();
  });
});

describe('extractBackgroundTaskLaunches', () => {
  it('extracts async Agent launch from SDK user tool_result event', () => {
    const event = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_abc',
            content: [
              {
                type: 'text',
                text: [
                  'Async agent launched successfully.',
                  'agentId: agent-123 (internal ID - do not mention to user.)',
                  'output_file: /tmp/claude/tasks/agent-123.output',
                ].join('\n'),
              },
            ],
          },
        ],
      },
    };

    expect(extractBackgroundTaskLaunches(event, new Map([[
      'call_abc',
      { name: 'Agent', description: 'Implement remaining tasks' },
    ]]))).toEqual([
      {
        taskId: 'agent-123',
        toolUseId: 'call_abc',
        description: 'Implement remaining tasks',
        outputFile: '/tmp/claude/tasks/agent-123.output',
      },
    ]);
  });

  it('extracts generic launch from backgroundTaskId', () => {
    const event = {
      type: 'user',
      toolUseResult: { backgroundTaskId: 'bash-123' },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_bash',
            content: 'Command running in background with ID: bash-123. Output is being written to: /tmp/tasks/bash-123.output.',
          },
        ],
      },
    };

    expect(extractBackgroundTaskLaunches(event, new Map([[
      'call_bash',
      { name: 'Bash', description: 'Wait before review' },
    ]]))).toEqual([
      {
        taskId: 'bash-123',
        toolUseId: 'call_bash',
        toolName: 'Bash',
        description: 'Wait before review',
        outputFile: '/tmp/tasks/bash-123.output',
      },
    ]);
  });

  it('extracts generic launch from taskId', () => {
    const event = {
      type: 'user',
      toolUseResult: { taskId: 'monitor-123', timeoutMs: 900000, persistent: false },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_monitor',
            content: 'Monitor started (task monitor-123, timeout 900000ms). You will be notified on each event.',
          },
        ],
      },
    };

    expect(extractBackgroundTaskLaunches(event, new Map([[
      'call_monitor',
      { name: 'Monitor', description: 'Jenkins build completion' },
    ]]))).toEqual([
      {
        taskId: 'monitor-123',
        toolUseId: 'call_monitor',
        toolName: 'Monitor',
        description: 'Jenkins build completion',
      },
    ]);
  });

  it('ignores generic task ids without known tool metadata', () => {
    const event = {
      type: 'user',
      toolUseResult: { taskId: 'monitor-123' },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_monitor',
            content: 'Monitor started (task monitor-123, timeout 900000ms).',
          },
        ],
      },
    };

    expect(extractBackgroundTaskLaunches(event, new Map())).toEqual([]);
  });

  it('ignores matching Agent launch text from non-Agent tool results', () => {
    const event = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_read',
            content: [
              {
                type: 'text',
                text: [
                  'Source code fixture:',
                  'Async agent launched successfully.',
                  'agentId: ${taskId} (internal ID - do not mention to user.)',
                  'output_file: /tmp/claude/tasks/${taskId}.output',
                ].join('\n'),
              },
            ],
          },
        ],
      },
    };

    expect(extractBackgroundTaskLaunches(event, new Map([[
      'call_read',
      { name: 'Read', description: 'Read fixture' },
    ]]))).toEqual([]);
  });
});
