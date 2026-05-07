import { describe, expect, it, vi } from 'vitest';
import { OrcdServer } from '../socket-server';
import type { SessionEventCallback } from '../session';
import type { PreparedCompaction } from '../../lib/session-compactor';
import type { ContextUsageMessage, SessionResultMessage, SessionExitMessage, CompactAction } from '../../shared/orcd-protocol';

const prepared: PreparedCompaction = {
  sessionId: 'session-1',
  jsonlPath: '/tmp/session.jsonl',
  summary: 'summary',
  lastOldLineIdx: 1,
  messagesBefore: 4,
  messagesCovered: 2,
  summaryChars: 7,
  prepareDurationMs: 12,
};

const applyResult = {
  sessionId: 'session-1',
  jsonlPath: '/tmp/session.jsonl',
  messagesBefore: 4,
  messagesCovered: 2,
  summaryTokens: 2,
  summaryChars: 7,
  durationMs: 3,
};

const compactorMocks = vi.hoisted(() => ({
  prepareCompaction: vi.fn(),
  applyCompaction: vi.fn(),
}));

vi.mock('../../lib/session-compactor', () => ({
  prepareCompaction: compactorMocks.prepareCompaction,
  applyCompaction: compactorMocks.applyCompaction,
  resolveJsonlPath: vi.fn(),
}));

function createServer() {
  return new OrcdServer('/tmp/orcd-test.sock', {
    test: { baseUrl: '', apiKey: '', models: ['test-model'], modelAliasEnv: {} },
  }, { provider: 'test', model: 'test-model' });
}

function createSession() {
  let hook: SessionEventCallback | undefined;
  let beforeExitHook: (() => Promise<void>) | undefined;
  const emitCompactBoundary = vi.fn();
  const emitBgcStarted = vi.fn();
  return {
    session: {
      id: 'session-1',
      cwd: '/tmp/project',
      model: 'test-model',
      provider: 'test',
      summarizeThreshold: 0.6,
      lastContextTokens: 80,
      lastContextWindow: 100,
      subscribe: vi.fn((cb: SessionEventCallback) => { hook = cb; }),
      onBeforeExit: vi.fn((cb: () => Promise<void>) => { beforeExitHook = cb; }),
      emitCompactBoundary,
      emitBgcStarted,
    },
    emitCompactBoundary,
    emitBgcStarted,
    getHook: () => {
      if (!hook) throw new Error('hook not attached');
      return hook;
    },
    runBeforeExit: async () => {
      if (!beforeExitHook) throw new Error('before exit hook not attached');
      await beforeExitHook();
    },
  };
}

describe('OrcdServer background compaction', () => {
  it('applies immediately when summary finishes and session is not active', async () => {
    compactorMocks.prepareCompaction.mockReset().mockResolvedValue(prepared);
    compactorMocks.applyCompaction.mockReset().mockResolvedValue(applyResult);
    const server = createServer();
    const { session, emitCompactBoundary, emitBgcStarted, getHook, runBeforeExit } = createSession();

    server['attachLifecycleHooks'](session as never);
    const hook = getHook();

    hook({ type: 'stream_event', sessionId: 'session-1', eventIndex: 1, event: { type: 'message_start' } });
    hook({ type: 'result', sessionId: 'session-1', eventIndex: 2, result: { subtype: 'success' } } satisfies SessionResultMessage);
    hook({ type: 'context_usage', sessionId: 'session-1', contextTokens: 80, contextWindow: 100 } satisfies ContextUsageMessage);

    await vi.waitFor(() => expect(compactorMocks.prepareCompaction).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(compactorMocks.applyCompaction).toHaveBeenCalledTimes(1));
    expect(emitBgcStarted).toHaveBeenCalledTimes(1);
    expect(compactorMocks.applyCompaction).toHaveBeenCalledWith(prepared);
    expect(emitCompactBoundary).toHaveBeenCalledTimes(1);

    await runBeforeExit();
    hook({ type: 'session_exit', sessionId: 'session-1', state: 'completed' } satisfies SessionExitMessage);

    expect(compactorMocks.applyCompaction).toHaveBeenCalledTimes(1);
  });

  it('starts BGC from explicit compact action and emits bgc_started', async () => {
    compactorMocks.prepareCompaction.mockReset().mockResolvedValue(prepared);
    compactorMocks.applyCompaction.mockReset().mockResolvedValue(applyResult);
    const server = createServer();
    const { session, emitCompactBoundary, emitBgcStarted } = createSession();
    server.store.add(session as never);
    server['attachLifecycleHooks'](session as never);

    server['handleAction']({ socket: null as never, subscriptions: new Map() }, {
      action: 'compact',
      sessionId: 'session-1',
      cwd: '/tmp/project',
      provider: 'test',
      model: 'test-model',
      contextWindow: 100,
      summarizeThreshold: 0.6,
    } satisfies CompactAction);

    await vi.waitFor(() => expect(compactorMocks.prepareCompaction).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(compactorMocks.applyCompaction).toHaveBeenCalledTimes(1));
    expect(emitBgcStarted).toHaveBeenCalledTimes(1);
    expect(emitCompactBoundary).toHaveBeenCalledTimes(1);
  });

  it('rehydrates inactive persisted sessions for explicit compact action', async () => {
    compactorMocks.prepareCompaction.mockReset().mockResolvedValue(prepared);
    compactorMocks.applyCompaction.mockReset().mockResolvedValue(applyResult);
    const server = createServer();
    const client = {
      socket: { writable: true, write: vi.fn() } as never,
      subscriptions: new Map(),
    };

    server['handleAction'](client, {
      action: 'compact',
      sessionId: 'session-1',
      cwd: '/tmp/project',
      provider: 'test',
      model: 'test-model',
      contextWindow: 100,
      summarizeThreshold: 0.6,
    } satisfies CompactAction);

    await vi.waitFor(() => expect(compactorMocks.prepareCompaction).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(compactorMocks.applyCompaction).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(server.store.get('session-1')).toBeUndefined());
    expect(client.subscriptions.has('session-1')).toBe(true);
  });
});
