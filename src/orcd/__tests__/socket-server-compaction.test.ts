import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { OrcdServer } from '../socket-server';
import { OrcdSession, type SessionEventCallback } from '../session';
import type { ContextUsageMessage, SessionResultMessage, SessionExitMessage, CompactAction, StreamEventMessage } from '../../shared/orcd-protocol';

async function createSkillProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrel-skill-project-'));
  await mkdir(join(dir, '.claude', 'skills', 'ask'), { recursive: true });
  await writeFile(
    join(dir, '.claude', 'skills', 'ask', 'SKILL.md'),
    '---\nname: ask\n---\n\nAnswer this: $ARGUMENTS\n',
  );
  return dir;
}

function createClient() {
  return {
    socket: { writable: true, write: vi.fn() },
    subscriptions: new Map(),
  };
}

async function collectPromptFromCreate(prompt: string): Promise<string> {
  const dir = await createSkillProject();
  const runSpy = vi.spyOn(OrcdSession.prototype, 'run').mockResolvedValue();
  try {
    const server = createServer();
    const client = createClient();
    server['handleAction'](client, {
      action: 'create',
      prompt,
      cwd: dir,
      provider: 'test',
      model: 'test-model',
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    const call = runSpy.mock.calls[0]?.[0];
    if (!call) throw new Error('expected run call');
    return call.prompt;
  } finally {
    runSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
}

async function collectPromptFromMessage(prompt: string): Promise<string> {
  const dir = await createSkillProject();
  const sendSpy = vi.spyOn(OrcdSession.prototype, 'sendMessage').mockResolvedValue();
  try {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: dir,
      model: 'test-model',
      provider: 'test',
      sessionId: 'session-message',
    });
    server.store.add(session);
    server['attachLifecycleHooks'](session);

    server['handleAction'](client, {
      action: 'message',
      sessionId: session.id,
      prompt,
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0];
    if (!call) throw new Error('expected sendMessage call');
    return call[0];
  } finally {
    sendSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
}


const compactDelegate = vi.fn(async () => ({
  messagesBefore: 4,
  messagesCovered: 2,
  summaryTokens: 2,
  summaryChars: 7,
}));

const applyResult = {
  sessionId: 'session-1',
  messagesBefore: 4,
  messagesCovered: 2,
  summaryTokens: 2,
  summaryChars: 7,
  durationMs: 3,
};

const compactorMocks = vi.hoisted(() => ({
  applyCompaction: vi.fn(),
}));

vi.mock('../../lib/session-compactor', () => ({
  applyCompaction: compactorMocks.applyCompaction,
}));

function createServer() {
  return new OrcdServer('/tmp/orcd-test.sock', {
    test: {
      type: 'anthropic',
      baseUrl: '',
      apiKey: '',
      models: { test: { label: 'Test Model', modelID: 'test-model', contextWindow: 100 } },
      modelAliasEnv: {},
    },
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
      compact: compactDelegate,
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

describe('OrcdServer prompt passthrough', () => {
  it('passes slash prompts through unchanged on session create', async () => {
    expect(await collectPromptFromCreate('/ask hello')).toBe('/ask hello');
  });

  it('passes slash prompts through unchanged on follow-up messages', async () => {
    expect(await collectPromptFromMessage('/ask hello')).toBe('/ask hello');
  });
});

describe('OrcdServer subscriptions', () => {
  it('does not replay the full buffer on duplicate live subscribes without a cursor', () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp/project',
      model: 'test-model',
      provider: 'test',
      sessionId: 'session-subscribe',
    });
    server.store.add(session);
    session['emitSyntheticSystemEvent']('compact_boundary');

    server['handleAction'](client, { action: 'subscribe', sessionId: session.id });
    const writesAfterFirst = client.socket.write.mock.calls.length;
    expect(writesAfterFirst).toBe(1);

    server['handleAction'](client, { action: 'subscribe', sessionId: session.id });
    expect(client.socket.write).toHaveBeenCalledTimes(writesAfterFirst);
  });

  it('replays only events after the requested cursor for duplicate subscribes', () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp/project',
      model: 'test-model',
      provider: 'test',
      sessionId: 'session-subscribe-cursor',
    });
    server.store.add(session);
    session['emitSyntheticSystemEvent']('compact_boundary');
    session['emitSyntheticSystemEvent']('bgc_started');

    server['handleAction'](client, { action: 'subscribe', sessionId: session.id });
    client.socket.write.mockClear();

    server['handleAction'](client, { action: 'subscribe', sessionId: session.id, afterEventIndex: 0 });

    expect(client.socket.write).toHaveBeenCalledTimes(1);
    const line = client.socket.write.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');
    const msg = JSON.parse(line as string) as StreamEventMessage;
    expect(msg.eventIndex).toBe(1);
    expect(msg.event).toEqual(expect.objectContaining({ subtype: 'bgc_started' }));
  });
});

describe('OrcdServer provider env', () => {
  it('merges process env and model alias env without injecting provider runtime env', () => {
    const saved = {
      ORC_TEST_PROVIDER_ENV: process.env.ORC_TEST_PROVIDER_ENV,
      ORC_PROVIDER_RUNTIME_URL: process.env.ORC_PROVIDER_RUNTIME_URL,
      ORC_PROVIDER_RUNTIME_KEY: process.env.ORC_PROVIDER_RUNTIME_KEY,
      ORC_PROVIDER_RUNTIME_TOKEN: process.env.ORC_PROVIDER_RUNTIME_TOKEN,
      ORC_PROVIDER_RUNTIME_REGION: process.env.ORC_PROVIDER_RUNTIME_REGION,
      ORC_PROVIDER_RUNTIME_PROFILE: process.env.ORC_PROVIDER_RUNTIME_PROFILE,
    };

    try {
      delete process.env.ORC_PROVIDER_RUNTIME_URL;
      delete process.env.ORC_PROVIDER_RUNTIME_KEY;
      delete process.env.ORC_PROVIDER_RUNTIME_TOKEN;
      delete process.env.ORC_PROVIDER_RUNTIME_REGION;
      delete process.env.ORC_PROVIDER_RUNTIME_PROFILE;
      process.env.ORC_TEST_PROVIDER_ENV = 'from-process';

      const server = new OrcdServer('/tmp/orcd-test.sock', {
        test: {
          type: 'bedrock',
          baseUrl: 'https://provider.test',
          apiKey: 'provider-api-key',
          authToken: 'provider-auth-token',
          region: 'us-east-1',
          profile: 'provider-profile',
          models: { test: { label: 'Test Model', modelID: 'test-model', contextWindow: 100 } },
          modelAliasEnv: {
            ORC_DEFAULT_MODEL: 'test-model',
          },
        },
      }, { provider: 'test', model: 'test-model' });

      const env = server['buildProviderEnv']('test');

      expect(env.ORC_TEST_PROVIDER_ENV).toBe('from-process');
      expect(env.ORC_DEFAULT_MODEL).toBe('test-model');
      expect(env.ORC_PROVIDER_RUNTIME_URL).toBeUndefined();
      expect(env.ORC_PROVIDER_RUNTIME_KEY).toBeUndefined();
      expect(env.ORC_PROVIDER_RUNTIME_TOKEN).toBeUndefined();
      expect(env.ORC_PROVIDER_RUNTIME_REGION).toBeUndefined();
      expect(env.ORC_PROVIDER_RUNTIME_PROFILE).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe('OrcdServer background compaction', () => {
  it('does not apply background compaction until beforeExit even after result', async () => {
    compactorMocks.applyCompaction.mockReset().mockResolvedValue(applyResult);
    compactDelegate.mockClear();
    const server = createServer();
    const { session, emitCompactBoundary, emitBgcStarted, getHook, runBeforeExit } = createSession();

    server['attachLifecycleHooks'](session as never);
    const hook = getHook();

    hook({ type: 'stream_event', sessionId: 'session-1', eventIndex: 1, event: { type: 'message_start' } });
    hook({ type: 'result', sessionId: 'session-1', eventIndex: 2, result: { subtype: 'success' } } satisfies SessionResultMessage);
    hook({ type: 'context_usage', sessionId: 'session-1', contextTokens: 80, contextWindow: 100 } satisfies ContextUsageMessage);

    await vi.waitFor(() => expect(emitBgcStarted).toHaveBeenCalledTimes(1));
    expect(compactorMocks.applyCompaction).not.toHaveBeenCalled();
    expect(emitCompactBoundary).not.toHaveBeenCalled();

    await runBeforeExit();
    expect(compactorMocks.applyCompaction).toHaveBeenCalledTimes(1);
    const preparedCall = compactorMocks.applyCompaction.mock.calls[0]?.[0];
    expect(preparedCall).toEqual(expect.objectContaining({ sessionId: 'session-1' }));
    expect(typeof preparedCall?.compact).toBe('function');
    await preparedCall?.compact();
    expect(compactDelegate).toHaveBeenCalledTimes(1);
    expect(emitCompactBoundary).toHaveBeenCalledTimes(1);

    hook({ type: 'session_exit', sessionId: 'session-1', state: 'completed' } satisfies SessionExitMessage);
    expect(compactorMocks.applyCompaction).toHaveBeenCalledTimes(1);
  });

  it('starts BGC from explicit compact action and emits bgc_started', async () => {
    compactorMocks.applyCompaction.mockReset().mockResolvedValue(applyResult);
    compactDelegate.mockClear();
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

    await vi.waitFor(() => expect(compactorMocks.applyCompaction).toHaveBeenCalledTimes(1));
    const preparedCall = compactorMocks.applyCompaction.mock.calls[0]?.[0];
    expect(preparedCall).toEqual(expect.objectContaining({ sessionId: 'session-1' }));
    expect(typeof preparedCall?.compact).toBe('function');
    await preparedCall?.compact();
    expect(compactDelegate).toHaveBeenCalledTimes(1);
    expect(emitBgcStarted).toHaveBeenCalledTimes(1);
    expect(emitCompactBoundary).toHaveBeenCalledTimes(1);
  });

  it('does not start a second BGC while the first compact apply is still running after session exit', async () => {
    let resolveApply: ((value: typeof applyResult) => void) | undefined;
    const applyPromise = new Promise<typeof applyResult>((resolve) => {
      resolveApply = resolve;
    });
    compactorMocks.applyCompaction.mockReset().mockReturnValue(applyPromise);
    const server = createServer();
    const { session, emitCompactBoundary, emitBgcStarted, getHook, runBeforeExit } = createSession();

    server['attachLifecycleHooks'](session as never);
    const hook = getHook();

    hook({ type: 'context_usage', sessionId: 'session-1', contextTokens: 80, contextWindow: 100 } satisfies ContextUsageMessage);
    await vi.waitFor(() => expect(emitBgcStarted).toHaveBeenCalledTimes(1));

    const beforeExit = runBeforeExit();
    await vi.waitFor(() => expect(compactorMocks.applyCompaction).toHaveBeenCalledTimes(1));
    hook({ type: 'session_exit', sessionId: 'session-1', state: 'completed' } satisfies SessionExitMessage);
    hook({ type: 'context_usage', sessionId: 'session-1', contextTokens: 82, contextWindow: 100 } satisfies ContextUsageMessage);

    expect(compactorMocks.applyCompaction).toHaveBeenCalledTimes(1);
    expect(emitBgcStarted).toHaveBeenCalledTimes(1);

    resolveApply?.(applyResult);
    await beforeExit;
    expect(emitCompactBoundary).toHaveBeenCalledTimes(1);
  });

  it('rehydrates inactive persisted sessions for explicit compact action', async () => {
    const compactSpy = vi.spyOn(OrcdSession.prototype, 'compact').mockResolvedValue({
      messagesBefore: 1,
      messagesCovered: 1,
      summaryChars: 1,
    });
    compactorMocks.applyCompaction.mockReset().mockResolvedValue(applyResult);
    const server = createServer();
    const client = {
      socket: { writable: true, write: vi.fn() } as never,
      subscriptions: new Map(),
    };

    try {
      server['handleAction'](client, {
        action: 'compact',
        sessionId: 'session-1',
        cwd: '/tmp/project',
        provider: 'test',
        model: 'test-model',
        contextWindow: 100,
        summarizeThreshold: 0.6,
      } satisfies CompactAction);

      await vi.waitFor(() => expect(compactorMocks.applyCompaction).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(server.store.get('session-1')).toBeUndefined());
      expect(client.subscriptions.has('session-1')).toBe(true);
    } finally {
      compactSpy.mockRestore();
    }
  });
});
