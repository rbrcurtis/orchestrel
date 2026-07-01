import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
    prepareBgCompaction: vi.fn(async () => null),
    applyBgCompaction: vi.fn(() => undefined),
    latestEntryIsCompaction: vi.fn(() => false),
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

  it('emits result on agent_end (once per run), not on intermediate turn_end', async () => {
    const assistant = { role: 'assistant', stopReason: 'end_turn', text: 'done' };
    const runtime = createRuntimeSession(
      [
        // An intermediate tool round must NOT produce a result (would flip the card).
        { type: 'turn_end', message: { id: 'msg-mid', text: 'thinking' }, toolResults: [] },
        { type: 'agent_end', willRetry: false, messages: [{ role: 'user', text: 'go' }, assistant] },
      ],
      'session-result',
    );
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-result',
    });

    const results: unknown[] = [];
    session.subscribe((msg) => {
      if (msg.type === 'result') results.push(msg.result);
    });

    await session.run({ prompt: 'go' });

    expect(results).toEqual([
      { type: 'result', subtype: 'success', message: assistant, toolResults: [] },
    ]);
  });

  it('emits a system/init event on first run so the UI shows "Session started"', async () => {
    const runtime = createRuntimeSession([], 'session-init');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-init',
    });

    const initEvents: Array<Record<string, unknown>> = [];
    session.subscribe((msg) => {
      if (msg.type !== 'stream_event') return;
      const evt = msg.event as Record<string, unknown>;
      if (evt.type === 'system' && evt.subtype === 'init') initEvents.push(evt);
    });

    await session.run({ prompt: 'go' });

    expect(initEvents).toHaveLength(1);
    expect(initEvents[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'session-init', model: 'test-model' });
  });

  it('emits context_usage for usage events', async () => {
    const runtime = createRuntimeSession([
      {
        type: 'message_update',
        message: {
          // Pi's Usage shape: components + totalTokens, no context window.
          usage: {
            input: 12000,
            output: 300,
            cacheRead: 45,
            cacheWrite: 0,
            totalTokens: 12345,
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
      // Window comes from session config, not the usage event.
      contextWindow: 262144,
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

  it('delays session_exit while the worktree has an enabled scheduled job, then exits once it fires', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orc-sess-sched-'));
    const storeDir = join(cwd, '.pi', 'subagent-schedules');
    mkdirSync(storeDir, { recursive: true });
    const storeFile = join(storeDir, 'job.json');
    const writeStore = (enabled: boolean) =>
      writeFileSync(storeFile, JSON.stringify({ version: 1, jobs: [{ id: 'j1', enabled }] }));
    writeStore(true);

    const runtime = createRuntimeSession([], 'session-sched');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd,
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-sched',
      scheduledJobPollMsForTesting: 5,
    });

    const received: string[] = [];
    session.subscribe((msg) => received.push(msg.type));

    const run = session.run({ prompt: 'go' });

    // Turn finished but the enabled job holds the session open — no exit yet.
    await new Promise((r) => setTimeout(r, 30));
    expect(received).not.toContain('session_exit');

    // The "once" job fires and disables itself → session is free to exit.
    writeStore(false);
    await run;

    expect(received.at(-1)).toBe('session_exit');

    rmSync(cwd, { recursive: true, force: true });
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

  it('forces session_exit on cancel when the run loop is wedged after abort', async () => {
    // Models the real lockup: a bash tool blocked on a native pipe read (a wedged
    // ssh whose ControlMaster holds stdout open) means prompt() never resolves and
    // abort() can't interrupt it. cancel() must still reconcile the card.
    const runtime = createRuntimeSession([], 'session-wedged');
    runtime.prompt = vi.fn(() => new Promise<void>(() => undefined));
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-wedged',
      cancelGraceMsForTesting: 20,
    });

    const payloads: unknown[] = [];
    session.subscribe((msg) => payloads.push(msg));

    // run() never resolves because prompt() is wedged — don't await it.
    void session.run({ prompt: 'go' });
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1));
    expect(payloads.some((m) => (m as { type: string }).type === 'session_exit')).toBe(false);

    await session.cancel();

    expect(runtime.abort).toHaveBeenCalledTimes(1);
    expect(payloads.at(-1)).toEqual({
      type: 'session_exit',
      sessionId: 'session-wedged',
      state: 'stopped',
    });
  });

  it('maps Pi subagent tool_execution events to the subagent line-item feed, deduping unchanged progress', async () => {
    const runtime = createRuntimeSession([
      { type: 'tool_execution_start', toolName: 'Agent', toolCallId: 'sub-1', args: { description: 'Explore repo' } },
      { type: 'tool_execution_update', toolName: 'Agent', toolCallId: 'sub-1', partialResult: { activity: 'finding files', status: 'running' } },
      { type: 'tool_execution_update', toolName: 'Agent', toolCallId: 'sub-1', partialResult: { activity: 'finding files', status: 'running' } },
      { type: 'tool_execution_update', toolName: 'Agent', toolCallId: 'sub-1', partialResult: { activity: 'editing', status: 'running' } },
      { type: 'tool_execution_end', toolName: 'Agent', toolCallId: 'sub-1', isError: false },
    ], 'session-subagent');
    pi.createPiRuntimeSession.mockResolvedValue(runtime);

    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test-provider',
      sessionId: 'session-subagent',
    });

    const taskEvents: Array<Record<string, unknown>> = [];
    session.subscribe((msg) => {
      if (msg.type !== 'stream_event') return;
      const evt = msg.event as Record<string, unknown>;
      if (typeof evt.type === 'string' && evt.type.startsWith('task_')) taskEvents.push(evt);
    });

    await session.run({ prompt: 'go' });

    expect(taskEvents).toEqual([
      { type: 'task_started', task_id: 'sub-1', description: 'Explore repo' },
      { type: 'task_progress', task_id: 'sub-1', data: 'finding files' },
      { type: 'task_progress', task_id: 'sub-1', data: 'editing' },
      { type: 'task_notification', task_id: 'sub-1', status: 'completed' },
    ]);
  });

  it('queues an overlapping prompt into Pi instead of dropping it', async () => {
    let releaseFirst: (() => void) | undefined;
    const runtime = createRuntimeSession([], 'session-overlap');
    // The follow-up enqueue returns immediately (Pi accepts it into its queue);
    // the initial run blocks so the session stays "running" while the overlap arrives.
    runtime.prompt = vi.fn(async (_text: string, opts?: { streamingBehavior?: string }) => {
      if (opts?.streamingBehavior === 'followUp') return;
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
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

    // The overlapping prompt was handed to Pi's queue as a follow-up, not dropped.
    expect(runtime.prompt).toHaveBeenCalledTimes(2);
    expect(runtime.prompt).toHaveBeenLastCalledWith('second', { streamingBehavior: 'followUp' });
    expect(payloads).not.toContainEqual(expect.objectContaining({ type: 'error' }));

    releaseFirst?.();
    await first;
  });
});
