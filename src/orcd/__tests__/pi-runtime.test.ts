import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrompt = vi.fn();
const mockSubscribe = vi.fn();
const mockAbort = vi.fn();
const mockCompact = vi.fn();
const mockSetThinkingLevel = vi.fn();
const mockFind = vi.fn();
const mockCreateAgentSession = vi.fn();
const mockSetRuntimeApiKey = vi.fn();
const mockAuthStorageCreate = vi.fn();
const mockModelRegistryCreate = vi.fn();
const mockSessionManagerCreate = vi.fn();
const mockSessionManagerList = vi.fn();
const mockSessionManagerOpen = vi.fn();
const mockGetAgentDir = vi.fn();

vi.mock('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: {
    create: mockAuthStorageCreate,
  },
  ModelRegistry: {
    create: mockModelRegistryCreate,
  },
  SessionManager: {
    create: mockSessionManagerCreate,
    list: mockSessionManagerList,
    open: mockSessionManagerOpen,
  },
  createAgentSession: mockCreateAgentSession,
  getAgentDir: mockGetAgentDir,
}));

vi.mock('@earendil-works/pi-ai', () => ({}));

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'pi-session-1',
    prompt: mockPrompt,
    subscribe: mockSubscribe,
    abort: mockAbort,
    compact: mockCompact,
    setThinkingLevel: mockSetThinkingLevel,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

describe('createPiRuntimeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetAgentDir.mockReturnValue('/home/ryan/.pi/agent');
    mockAuthStorageCreate.mockReturnValue({ kind: 'auth-storage', setRuntimeApiKey: mockSetRuntimeApiKey });
    mockFind.mockReturnValue({ provider: 'anthropic', id: 'claude-sonnet-4-6' });
    mockModelRegistryCreate.mockReturnValue({ find: mockFind, registerProvider: vi.fn() });
    mockSessionManagerCreate.mockReturnValue({ kind: 'session-manager-create' });
    mockSessionManagerList.mockResolvedValue([]);
    mockSessionManagerOpen.mockReturnValue({ kind: 'session-manager-open' });
    mockCreateAgentSession.mockResolvedValue({ session: makeSession() });
    mockPrompt.mockResolvedValue(undefined);
    mockAbort.mockResolvedValue(undefined);
    mockCompact.mockResolvedValue({ ok: true });
  });

  it('creates a Pi session with Pi resource paths and mapped effort', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');

    const session = await createPiRuntimeSession({
      cwd: '/repo',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      effort: 'max',
    });

    expect(session.id).toBe('pi-session-1');
    expect(mockGetAgentDir).toHaveBeenCalledOnce();
    const authStorage = { kind: 'auth-storage', setRuntimeApiKey: mockSetRuntimeApiKey };
    expect(mockAuthStorageCreate).toHaveBeenCalledWith('/home/ryan/.pi/agent/auth.json');
    expect(mockModelRegistryCreate).toHaveBeenCalledWith(authStorage, '/home/ryan/.pi/agent/models.json');
    expect(mockFind).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-6');
    expect(mockSessionManagerCreate).toHaveBeenCalledWith('/repo');
    expect(mockCreateAgentSession).toHaveBeenCalledWith({
      cwd: '/repo',
      agentDir: '/home/ryan/.pi/agent',
      authStorage,
      modelRegistry: { find: mockFind, registerProvider: expect.any(Function) },
      sessionManager: { kind: 'session-manager-create' },
      model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      thinkingLevel: 'xhigh',
    });
  });

  it('pins new Pi session storage to the orcd session id when provided', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');

    const session = await createPiRuntimeSession({
      cwd: '/repo',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      sessionId: 'orcd-session-1',
    });

    expect(mockSessionManagerList).toHaveBeenCalledWith('/repo');
    expect(mockSessionManagerCreate).toHaveBeenLastCalledWith('/repo', undefined, { id: 'orcd-session-1' });
    expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: { kind: 'session-manager-create' },
    }));
    expect(session.id).toBe('pi-session-1');
  });

  it('opens existing Pi session storage when resuming by orcd session id', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    mockSessionManagerList.mockResolvedValue([
      { id: 'orcd-session-1', path: '/home/ryan/.pi/agent/sessions/repo/session.jsonl' },
    ]);

    await createPiRuntimeSession({
      cwd: '/repo',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      sessionId: 'orcd-session-1',
    });

    expect(mockSessionManagerOpen).toHaveBeenCalledWith('/home/ryan/.pi/agent/sessions/repo/session.jsonl', undefined, '/repo');
    expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: { kind: 'session-manager-open' },
    }));
  });

  it('resolves app aliases for built-in Anthropic passthrough providers without re-registering them', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    const registry = { find: mockFind, registerProvider: vi.fn() };
    mockModelRegistryCreate.mockReturnValue(registry);

    await createPiRuntimeSession({
      cwd: '/repo',
      providerId: 'pi-local-test',
      modelId: 'sonnet',
      provider: {
        type: 'anthropic',
        label: 'Pi Local Test',
        baseUrl: '',
        apiKey: '',
        models: {
          sonnet: { label: 'Sonnet 4.6', modelID: 'claude-sonnet-4-6', contextWindow: 200000 },
        },
      },
    });

    expect(registry.registerProvider).not.toHaveBeenCalled();
    expect(mockSetRuntimeApiKey).not.toHaveBeenCalled();
    expect(mockFind).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-6');
  });

  it('uses runtime API keys for built-in Anthropic providers when configured', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');

    await createPiRuntimeSession({
      cwd: '/repo',
      providerId: 'anthropic',
      modelId: 'sonnet',
      provider: {
        type: 'anthropic',
        label: 'Anthropic',
        baseUrl: '',
        apiKey: 'sk-test',
        models: {
          sonnet: { label: 'Sonnet 4.6', modelID: 'claude-sonnet-4-6', contextWindow: 200000 },
        },
      },
    });

    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-test');
    expect(mockFind).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-6');
  });

  it('registers configured proxy providers and resolves app model aliases to Pi model IDs', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    const registry = { find: mockFind, registerProvider: vi.fn() };
    mockModelRegistryCreate.mockReturnValue(registry);

    await createPiRuntimeSession({
      cwd: '/repo',
      providerId: 'trackable',
      modelId: 'sonnet',
      provider: {
        type: 'anthropic',
        label: 'Trackable',
        baseUrl: 'http://127.0.0.1:3457',
        apiKey: 'trackable',
        models: {
          sonnet: { label: 'Sonnet 4.6', modelID: 'claude-sonnet-4-6', contextWindow: 200000 },
        },
      },
    });

    expect(registry.registerProvider).toHaveBeenCalledWith('trackable', {
      name: 'Trackable',
      api: 'anthropic-messages',
      baseUrl: 'http://127.0.0.1:3457',
      apiKey: 'trackable',
      models: [
        {
          id: 'claude-sonnet-4-6',
          name: 'Sonnet 4.6',
          api: 'anthropic-messages',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 64000,
        },
      ],
    });
    expect(mockFind).toHaveBeenCalledWith('trackable', 'claude-sonnet-4-6');
  });

  it('maps unsupported or disabled efforts to stable Pi thinking levels', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');

    await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm', effort: 'disabled' });
    await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm', effort: 'low' });
    await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm', effort: 'medium' });
    await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm', effort: 'surprise' });

    expect(mockCreateAgentSession.mock.calls.map((call) => call[0].thinkingLevel)).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
  });

  it("throws when Pi model lookup doesn't find the configured model", async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    mockFind.mockReturnValue(undefined);

    await expect(
      createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'missing' }),
    ).rejects.toThrow('Pi model not found: anthropic/missing');

    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it("forwards prompt('hello')", async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    const session = await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm' });

    await session.prompt('hello', { streamingBehavior: 'steer' });

    expect(mockPrompt).toHaveBeenCalledWith('hello', { streamingBehavior: 'steer' });
  });

  it('subscribe forwards callback to Pi session events and returns SDK unsubscribe handle', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    const event = { type: 'turn_end' };
    const unsubscribe = vi.fn();
    mockSubscribe.mockImplementation((cb: (event: unknown) => void) => {
      cb(event);
      return unsubscribe;
    });
    const cb = vi.fn();
    const session = await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm' });

    const returnedUnsubscribe = session.subscribe(cb);
    returnedUnsubscribe();

    expect(cb).toHaveBeenCalledWith(event);
    expect(returnedUnsubscribe).toBe(unsubscribe);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('abort, compact, and setEffort call through when supported', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    const session = await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm' });

    await session.abort();
    const compactResult = await session.compact('keep only the summary');
    await session.setEffort('disabled');

    expect(mockAbort).toHaveBeenCalledOnce();
    expect(mockCompact).toHaveBeenCalledWith('keep only the summary');
    expect(compactResult).toEqual({ ok: true });
    expect(mockSetThinkingLevel).toHaveBeenCalledWith('off');
  });

  it('compact and setEffort no-op when Pi runtime methods are absent', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    mockCreateAgentSession.mockResolvedValue({
      session: makeSession({ compact: undefined, setThinkingLevel: undefined }),
    });
    const session = await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm' });

    await expect(session.compact()).resolves.toBeUndefined();
    await expect(session.setEffort('high')).resolves.toBeUndefined();
  });

  it('setEffort still calls setThinkingLevel when compact is missing', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    mockCreateAgentSession.mockResolvedValue({
      session: makeSession({ compact: undefined }),
    });
    const session = await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm' });

    await expect(session.compact()).resolves.toBeUndefined();
    await session.setEffort('max');

    expect(mockSetThinkingLevel).toHaveBeenCalledWith('xhigh');
  });

  it('compact still executes when setThinkingLevel is missing', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    mockCreateAgentSession.mockResolvedValue({
      session: makeSession({ setThinkingLevel: undefined }),
    });
    const session = await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm' });

    const compactResult = await session.compact('summarize');
    await expect(session.setEffort('high')).resolves.toBeUndefined();

    expect(mockCompact).toHaveBeenCalledWith('summarize');
    expect(compactResult).toEqual({ ok: true });
  });

  it('getMessages returns messages array or []', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    const session = await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm' });

    expect(session.getMessages()).toEqual([{ role: 'user', content: 'hello' }]);

    mockCreateAgentSession.mockResolvedValue({ session: makeSession({ messages: undefined }) });
    const sessionWithoutMessages = await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm' });

    expect(sessionWithoutMessages.getMessages()).toEqual([]);
  });
});
