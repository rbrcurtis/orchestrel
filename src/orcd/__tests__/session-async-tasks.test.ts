import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it, vi } from 'vitest';
import { OrcdSession } from '../session';
import type { SessionEventCallback } from '../session';

const events: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    interrupt: vi.fn(),
    setMaxThinkingTokens: vi.fn(),
  }),
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
  it('delays session_exit until async task notification appears in JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrel-session-'));
    const jsonlPath = join(dir, 'session.jsonl');
    await writeFile(jsonlPath, '');

    events.length = 0;
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
    await vi.waitFor(() => expect(received).toContain('result'));
    expect(received).not.toContain('session_exit');
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_event',
      event: { type: 'task_started', task_id: 'agent-123', description: 'Implement remaining tasks' },
    }));

    await writeFile(jsonlPath, JSON.stringify({
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
      event: { type: 'task_notification', task_id: 'agent-123', status: 'completed', result: 'DONE' },
    }));
    expect(received.at(-1)).toBe('session_exit');

    const finalContent = await readFile(jsonlPath, 'utf8');
    expect(finalContent).toContain('<task-notification>');
    await rm(dir, { recursive: true, force: true });
  });
});
