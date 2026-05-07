import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrcdSession } from '../session';
import type { SessionEventCallback } from '../session';

const events: unknown[] = [];
const sdkQuery = vi.hoisted(() => vi.fn(() => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) yield event;
  },
  interrupt: vi.fn(),
  setMaxThinkingTokens: vi.fn(),
})));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkQuery,
}));

function toolUseEvent(id: string, description: string): unknown {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Agent',
          input: { description, run_in_background: true },
        },
      ],
    },
  };
}

function asyncLaunchResult(toolUseId: string, taskId: string): unknown {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [
            {
              type: 'text',
              text: [
                'Async agent launched successfully.',
                `agentId: ${taskId} (internal ID - do not mention to user.)`,
                `output_file: /tmp/claude/tasks/${taskId}.output`,
              ].join('\n'),
            },
          ],
        },
      ],
    },
  };
}

describe('OrcdSession async Agent lifecycle', () => {
  beforeEach(() => {
    events.length = 0;
    sdkQuery.mockClear();
  });

  it('disables broken skills in Agent SDK options', async () => {
    events.push({ type: 'result', subtype: 'success', stop_reason: 'end_turn' });

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-skills',
    });

    await session.run({ prompt: 'go' });

    expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        disallowedTools: expect.arrayContaining(['AskUserQuestion']),
        settings: expect.objectContaining({
          skillOverrides: expect.objectContaining({
            'claude-api': 'off',
          }),
        }),
      }),
    }));
  });

  it('delays session_exit until async task notification appears in JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrel-session-'));
    const jsonlPath = join(dir, 'session.jsonl');
    await writeFile(jsonlPath, '');

    events.push(
      toolUseEvent('call_abc', 'Implement remaining tasks'),
      asyncLaunchResult('call_abc', 'agent-123'),
      {
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        modelUsage: { test: { contextWindow: 200000 } },
      },
    );

    const session = new OrcdSession({
      cwd: dir,
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session',
      jsonlPathForTesting: jsonlPath,
      asyncTaskPollMsForTesting: 10,
    });

    const received: string[] = [];
    const payloads: unknown[] = [];
    const cb: SessionEventCallback = (msg) => {
      received.push(msg.type);
      payloads.push(msg);
    };
    session.subscribe(cb);

    const run = session.run({ prompt: 'go' });

    try {
      await vi.waitFor(() => expect(received).toContain('result'));
      expect(received).not.toContain('session_exit');
      expect(payloads).toContainEqual(expect.objectContaining({
        type: 'stream_event',
        event: expect.objectContaining({
          type: 'task_started',
          task_id: 'agent-123',
          description: 'Implement remaining tasks',
        }),
      }));

      await appendFile(jsonlPath, JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: [
          '<task-notification>',
          '<task-id>agent-123</task-id>',
          '<tool-use-id>call_abc</tool-use-id>',
          '<status>completed</status>',
          '<result>DONE</result>',
          '</task-notification>',
        ].join('\n'),
      }) + '\n');
      await run;

      expect(payloads).toContainEqual(expect.objectContaining({
        type: 'stream_event',
        event: expect.objectContaining({
          type: 'task_notification',
          task_id: 'agent-123',
          status: 'completed',
          result: 'DONE',
        }),
      }));
      expect(received.at(-1)).toBe('session_exit');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits failed task_notification and still exits the session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrel-session-'));
    const jsonlPath = join(dir, 'session.jsonl');
    await writeFile(jsonlPath, '');

    events.push(
      toolUseEvent('call_failed', 'Run async work that fails'),
      asyncLaunchResult('call_failed', 'agent-failed-123'),
      {
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        modelUsage: { test: { contextWindow: 200000 } },
      },
    );

    const session = new OrcdSession({
      cwd: dir,
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-failed',
      jsonlPathForTesting: jsonlPath,
      asyncTaskPollMsForTesting: 10,
    });

    const received: string[] = [];
    const payloads: unknown[] = [];
    const cb: SessionEventCallback = (msg) => {
      received.push(msg.type);
      payloads.push(msg);
    };
    session.subscribe(cb);

    const run = session.run({ prompt: 'go' });

    try {
      await vi.waitFor(() => expect(received).toContain('result'));
      expect(received).not.toContain('session_exit');

      await appendFile(jsonlPath, JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: [
          '<task-notification>',
          '<task-id>agent-failed-123</task-id>',
          '<tool-use-id>call_failed</tool-use-id>',
          '<status>failed</status>',
          '<result>BLOCKED</result>',
          '</task-notification>',
        ].join('\n'),
      }) + '\n');

      await run;

      expect(payloads).toContainEqual(expect.objectContaining({
        type: 'stream_event',
        event: expect.objectContaining({
          type: 'task_notification',
          task_id: 'agent-failed-123',
          status: 'failed',
          result: 'BLOCKED',
        }),
      }));
      expect(payloads.at(-1)).toEqual(expect.objectContaining({
        type: 'session_exit',
        state: 'completed',
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits stopped session_exit when cancelled while waiting for async task notification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrel-session-'));
    const jsonlPath = join(dir, 'session.jsonl');
    await writeFile(jsonlPath, '');

    events.push(
      toolUseEvent('call_cancel', 'Run follow-up async work'),
      asyncLaunchResult('call_cancel', 'agent-cancel-123'),
      {
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        modelUsage: { test: { contextWindow: 200000 } },
      },
    );

    const session = new OrcdSession({
      cwd: dir,
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-cancel',
      jsonlPathForTesting: jsonlPath,
      asyncTaskPollMsForTesting: 10,
    });

    const received: string[] = [];
    const payloads: unknown[] = [];
    const cb: SessionEventCallback = (msg) => {
      received.push(msg.type);
      payloads.push(msg);
    };
    session.subscribe(cb);

    const run = session.run({ prompt: 'go' });

    try {
      await vi.waitFor(() => expect(received).toContain('result'));
      expect(received).not.toContain('session_exit');

      await session.cancel();
      await run;

      expect(payloads.at(-1)).toEqual(expect.objectContaining({
        type: 'session_exit',
        state: 'stopped',
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
