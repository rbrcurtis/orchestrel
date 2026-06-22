import { describe, expect, it } from 'vitest';
import {
  AsyncTaskTracker,
  extractAsyncAgentLaunches,
  parseAsyncAgentLaunch,
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

  it('returns null for unrelated queue content', () => {
    expect(parseTaskNotification('Continue')).toBeNull();
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

describe('extractAsyncAgentLaunches', () => {
  it('extracts async launch from SDK user tool_result event', () => {
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

    expect(extractAsyncAgentLaunches(event, new Map([['call_abc', 'Implement remaining tasks']]))).toEqual([
      {
        taskId: 'agent-123',
        toolUseId: 'call_abc',
        description: 'Implement remaining tasks',
        outputFile: '/tmp/claude/tasks/agent-123.output',
      },
    ]);
  });

  it('ignores matching launch text from non-Agent tool results', () => {
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

    expect(extractAsyncAgentLaunches(event, new Map())).toEqual([]);
  });
});
