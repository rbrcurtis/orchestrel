import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrcdSession } from '../session';
import type { PiRuntimeSession } from '../pi-runtime';
import type { SessionEventCallback } from '../session';

const pi = vi.hoisted(() => ({
  createPiRuntimeSession: vi.fn(),
}));

vi.mock('../pi-runtime', () => ({
  createPiRuntimeSession: pi.createPiRuntimeSession,
}));

interface TestRuntimeSession extends PiRuntimeSession {
  emit(event: unknown): void;
  resolvePrompt(): void;
}

function createRuntimeSession(events: unknown[] = [], id = 'session'): TestRuntimeSession {
  const subscribers = new Set<(event: unknown) => void>();
  const session: TestRuntimeSession = {
    id,
    prompt: vi.fn(async () => {
      for (const event of events) session.emit(event);
    }),
    subscribe: vi.fn((cb: (event: unknown) => void) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    }),
    abort: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({ ok: true })),
    setEffort: vi.fn(async () => undefined),
    getMessages: vi.fn(() => []),
    emit(event: unknown) {
      for (const cb of subscribers) cb(event);
    },
    resolvePrompt() {
      return undefined;
    },
  };
  return session;
}

function createBlockedRuntimeSession(events: unknown[] = [], id = 'session'): TestRuntimeSession {
  const session = createRuntimeSession(events, id);
  let resolvePrompt: (() => void) | undefined;
  session.prompt = vi.fn(async () => {
    for (const event of events) session.emit(event);
    await new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
  });
  session.resolvePrompt = () => resolvePrompt?.();
  return session;
}

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
                `output_file: /tmp/pi/tasks/${taskId}.output`,
              ].join('\n'),
            },
          ],
        },
      ],
    },
  };
}

function taskNotification(taskId: string, toolUseId: string, status: 'completed' | 'failed' = 'completed'): unknown {
  return {
    type: 'message_update',
    message: {
      content: [
        {
          type: 'text',
          text: [
            '<task-notification>',
            `<task-id>${taskId}</task-id>`,
            `<tool-use-id>${toolUseId}</tool-use-id>`,
            `<status>${status}</status>`,
            '<result>DONE</result>',
            '</task-notification>',
          ].join('\n'),
        },
      ],
    },
  };
}

describe('OrcdSession Pi runtime loop', () => {
  beforeEach(() => {
    pi.createPiRuntimeSession.mockReset();
  });

  it('creates a Pi runtime session and forwards the initial prompt', async () => {
    const runtime = createRuntimeSession([], 'session-prompt');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp/project',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-prompt',
    });

    await session.run({ prompt: 'go', effort: 'high' });

    expect(pi.createPiRuntimeSession).toHaveBeenCalledWith({
      cwd: '/tmp/project',
      providerId: 'test-provider',
      modelId: 'test-model',
      sessionId: 'session-prompt',
      effort: 'high',
    });
    expect(runtime.prompt).toHaveBeenCalledWith('go', undefined);
  });

  it('emits stream_event for ordinary Pi events', async () => {
    const event = { type: 'message_update', message: { text: 'hello' } };
    const runtime = createRuntimeSession([event], 'session-stream');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-stream',
    });

    const payloads: unknown[] = [];
    session.subscribe((msg) => payloads.push(msg));

    await session.run({ prompt: 'go' });

    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_event',
      sessionId: 'session-stream',
      event,
    }));
  });

  it('emits result for turn_end mapped events', async () => {
    const event = {
      type: 'turn_end',
      message: { id: 'msg-1', text: 'done' },
      toolResults: [{ id: 'tool-1', ok: true }],
    };
    const runtime = createRuntimeSession([event], 'session-result');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-result',
    });

    const payloads: unknown[] = [];
    session.subscribe((msg) => payloads.push(msg));

    await session.run({ prompt: 'go' });

    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'result',
      sessionId: 'session-result',
      result: {
        type: 'result',
        subtype: 'success',
        message: event.message,
        toolResults: event.toolResults,
      },
    }));
  });

  it('emits context_usage for usage events', async () => {
    const runtime = createRuntimeSession([
      {
        type: 'message_update',
        message: {
          usage: {
            inputTokens: 12345,
            contextWindow: 262144,
          },
        },
      },
    ], 'session-usage');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-usage',
    });

    const payloads: unknown[] = [];
    session.subscribe((msg) => payloads.push(msg));

    await session.run({ prompt: 'go' });

    expect(session.lastContextTokens).toBe(12345);
    expect(session.lastContextWindow).toBe(262144);
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'context_usage',
      sessionId: 'session-usage',
      contextTokens: 12345,
      contextWindow: 262144,
    }));
  });

  it('emits session_exit after completion', async () => {
    const runtime = createRuntimeSession([], 'session-exit');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-exit',
    });

    const payloads: unknown[] = [];
    session.subscribe((msg) => payloads.push(msg));

    await session.run({ prompt: 'go' });

    expect(payloads.at(-1)).toEqual({
      type: 'session_exit',
      sessionId: 'session-exit',
      state: 'completed',
    });
  });

  it('sends follow-up prompts with followUp streaming behavior', async () => {
    const runtime = createRuntimeSession([], 'session-follow-up');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-follow-up',
    });

    await session.sendMessage('continue');

    expect(runtime.prompt).toHaveBeenCalledWith('continue', { streamingBehavior: 'followUp' });
  });

  it('delegates setEffort, cancel, and compact to the active Pi runtime session', async () => {
    const runtime = createRuntimeSession([], 'session-delegate');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-delegate',
    });

    await session.run({ prompt: 'go' });
    await session.setEffort('max');
    await session.cancel();
    await expect(session.compact()).resolves.toEqual({ ok: true });

    expect(runtime.setEffort).toHaveBeenCalledWith('max');
    expect(runtime.abort).toHaveBeenCalledTimes(1);
    expect(runtime.compact).toHaveBeenCalledTimes(1);
  });

  it('creates a Pi runtime session when compacting an inactive session', async () => {
    const runtime = createRuntimeSession([], 'session-inactive-compact');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp/project',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-inactive-compact',
    });

    await expect(session.compact()).resolves.toEqual({ ok: true });

    expect(pi.createPiRuntimeSession).toHaveBeenCalledWith({
      cwd: '/tmp/project',
      providerId: 'test-provider',
      modelId: 'test-model',
      sessionId: 'session-inactive-compact',
      effort: undefined,
    });
    expect(runtime.compact).toHaveBeenCalledTimes(1);
  });

  it('emits task_started for async agent launches seen in live Pi events', async () => {
    const runtime = createRuntimeSession([
      toolUseEvent('call_abc', 'Implement remaining tasks'),
      asyncLaunchResult('call_abc', 'agent-123'),
    ], 'session-task');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-task',
      asyncTaskPollMsForTesting: 10,
    });

    const payloads: unknown[] = [];
    const cb: SessionEventCallback = (msg) => payloads.push(msg);
    session.subscribe(cb);

    const run = session.run({ prompt: 'go' });
    await vi.waitFor(() => expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_event',
      event: expect.objectContaining({
        type: 'task_started',
        task_id: 'agent-123',
        description: 'Implement remaining tasks',
      }),
    })));
    runtime.emit(taskNotification('agent-123', 'call_abc'));
    await run;
  });

  it('delays session_exit until pending async task notification arrives from Pi events', async () => {
    const runtime = createRuntimeSession([
      toolUseEvent('call_delay', 'Wait for async work'),
      asyncLaunchResult('call_delay', 'agent-delay-123'),
    ], 'session-delay');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-delay',
      asyncTaskPollMsForTesting: 10,
    });

    const payloads: unknown[] = [];
    const received: string[] = [];
    session.subscribe((msg) => {
      payloads.push(msg);
      received.push(msg.type);
    });

    const run = session.run({ prompt: 'go' });
    await vi.waitFor(() => expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_event',
      event: expect.objectContaining({ type: 'task_started', task_id: 'agent-delay-123' }),
    })));
    expect(received).not.toContain('session_exit');

    runtime.emit(taskNotification('agent-delay-123', 'call_delay'));
    await run;

    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_event',
      event: expect.objectContaining({
        type: 'task_notification',
        task_id: 'agent-delay-123',
        status: 'completed',
        result: 'DONE',
      }),
    }));
    expect(payloads.at(-1)).toEqual({
      type: 'session_exit',
      sessionId: 'session-delay',
      state: 'completed',
    });
  });

  it('emits stopped session_exit when cancelled while waiting for async task notification', async () => {
    const runtime = createRuntimeSession([
      toolUseEvent('call_cancel', 'Run follow-up async work'),
      asyncLaunchResult('call_cancel', 'agent-cancel-123'),
    ], 'session-cancel');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-cancel',
      asyncTaskPollMsForTesting: 10,
    });

    const payloads: unknown[] = [];
    const received: string[] = [];
    session.subscribe((msg) => {
      payloads.push(msg);
      received.push(msg.type);
    });

    const run = session.run({ prompt: 'go' });
    await vi.waitFor(() => expect(payloads).toContainEqual(expect.objectContaining({
      type: 'stream_event',
      event: expect.objectContaining({ type: 'task_started', task_id: 'agent-cancel-123' }),
    })));
    expect(received).not.toContain('session_exit');

    await session.cancel();
    await run;

    expect(runtime.abort).toHaveBeenCalledTimes(1);
    expect(payloads.at(-1)).toEqual({
      type: 'session_exit',
      sessionId: 'session-cancel',
      state: 'stopped',
    });
  });

  it('rejects overlapping runs without duplicate event forwarding', async () => {
    const event = { type: 'message_update', message: { text: 'one event' } };
    const runtime = createBlockedRuntimeSession([], 'session-overlap');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-overlap',
    });

    const payloads: unknown[] = [];
    session.subscribe((msg) => payloads.push(msg));

    const first = session.run({ prompt: 'first' });
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1));
    await session.sendMessage('second');

    runtime.emit(event);
    runtime.resolvePrompt();
    await first;

    const forwardedEvents = payloads.filter((msg): msg is { type: 'stream_event'; event: unknown } => (
      typeof msg === 'object'
      && msg !== null
      && 'type' in msg
      && msg.type === 'stream_event'
      && 'event' in msg
      && msg.event === event
    ));
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
    expect(forwardedEvents).toHaveLength(1);
    expect(payloads).toContainEqual(expect.objectContaining({
      type: 'error',
      sessionId: 'session-overlap',
      error: 'session already running; dropping overlapping prompt',
    }));
  });
});
