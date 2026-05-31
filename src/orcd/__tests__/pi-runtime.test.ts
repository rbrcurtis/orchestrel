import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrompt = vi.fn();
const mockSubscribe = vi.fn();
const mockAbort = vi.fn();
const mockCompact = vi.fn();
const mockSetThinkingLevel = vi.fn();
const mockFind = vi.fn();
const mockCreateAgentSession = vi.fn();
const mockAuthStorageCreate = vi.fn();
const mockModelRegistryCreate = vi.fn();
const mockGetAgentDir = vi.fn();

vi.mock('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: {
    create: mockAuthStorageCreate,
  },
  ModelRegistry: {
    create: mockModelRegistryCreate,
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
    mockAuthStorageCreate.mockReturnValue({ kind: 'auth-storage' });
    mockFind.mockReturnValue({ provider: 'anthropic', id: 'claude-sonnet-4-6' });
    mockModelRegistryCreate.mockReturnValue({ find: mockFind });
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
    expect(mockAuthStorageCreate).toHaveBeenCalledWith('/home/ryan/.pi/agent/auth.json');
    expect(mockModelRegistryCreate).toHaveBeenCalledWith({ kind: 'auth-storage' }, '/home/ryan/.pi/agent/models.json');
    expect(mockFind).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-6');
    expect(mockCreateAgentSession).toHaveBeenCalledWith({
      cwd: '/repo',
      agentDir: '/home/ryan/.pi/agent',
      authStorage: { kind: 'auth-storage' },
      modelRegistry: { find: mockFind },
      model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      thinkingLevel: 'xhigh',
    });
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
