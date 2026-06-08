import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrcdSession } from '../session';
import type { SessionEventCallback } from '../session';

const events: unknown[] = [];
const sdkControls = vi.hoisted(() => ({
  close: vi.fn(),
  interrupt: vi.fn(),
  setMaxThinkingTokens: vi.fn(),
}));
const sdkQuery = vi.hoisted(() => vi.fn(() => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) yield event;
  },
  close: sdkControls.close,
  interrupt: sdkControls.interrupt,
  setMaxThinkingTokens: sdkControls.setMaxThinkingTokens,
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
    sdkControls.close.mockClear();
    sdkControls.interrupt.mockClear();
    sdkControls.setMaxThinkingTokens.mockClear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
        disallowedTools: expect.arrayContaining([
          'AskUserQuestion',
          'CronCreate',
          'CronDelete',
          'CronList',
          'ScheduleWakeup',
          'WebFetch',
          'WebSearch',
          'Workflow',
        ]),
        settings: expect.objectContaining({
          skillOverrides: expect.objectContaining({
            'claude-api': 'off',
          }),
        }),
      }),
    }));
  });

  it('logs retry details before closing the Agent SDK query on provider retry events', async () => {
    events.push({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 2,
      retry_delay_ms: 1000,
      error_status: 500,
      error: {
        message: 'server_error',
        authToken: 'do-not-log',
      },
    });

    const session = new OrcdSession({
      cwd: '/tmp/project',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-no-retry',
    });

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const payloads: unknown[] = [];
    session.subscribe((msg) => payloads.push(msg));

    await session.run({
      prompt: 'go',
      env: {
        ANTHROPIC_BASE_URL: 'http://provider.local:8000',
        ANTHROPIC_AUTH_TOKEN: 'secret-token',
      },
    });

    expect(sdkControls.close).toHaveBeenCalledTimes(1);
    expect(payloads).not.toContainEqual(expect.objectContaining({
      type: 'stream_event',
      event: expect.objectContaining({ subtype: 'api_retry' }),
    }));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'error',
      error: expect.stringContaining('HTTP 500: server_error'),
    }));
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'session_exit',
      state: 'errored',
    }));

    const retryLog = logs.find((line) => line.includes('api_retry'));
    expect(retryLog).toEqual(expect.stringContaining('session-no-retry'));
    expect(retryLog).toEqual(expect.stringContaining('test-provider'));
    expect(retryLog).toEqual(expect.stringContaining('test-model'));
    expect(retryLog).toEqual(expect.stringContaining('http://provider.local:8000'));
    expect(retryLog).toEqual(expect.stringContaining('server_error'));
    expect(retryLog).toEqual(expect.stringContaining('[REDACTED]'));
    expect(retryLog).not.toContain('secret-token');
    expect(retryLog).not.toContain('do-not-log');
  });

  it('prefers configured contextWindow over SDK modelUsage metadata', async () => {
    events.push(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: { input_tokens: 12345 },
          },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        modelUsage: { test: { contextWindow: 200000 } },
      },
    );

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'qwen3-coder-next',
      provider: 'max',
      sessionId: 'session-context-window',
      contextWindow: 262144,
    });

    const payloads: unknown[] = [];
    session.subscribe((msg) => payloads.push(msg));

    await session.run({ prompt: 'go' });

    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'context_usage',
      contextTokens: 12345,
      contextWindow: 262144,
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
