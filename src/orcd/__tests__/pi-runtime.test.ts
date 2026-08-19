import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrompt = vi.fn();
const mockSubscribe = vi.fn();
const mockAbort = vi.fn();
const mockCompact = vi.fn();
const mockSetThinkingLevel = vi.fn();
const mockBindExtensions = vi.fn();
const mockFind = vi.fn();
const mockCreateAgentSession = vi.fn();
const mockSetRuntimeApiKey = vi.fn();
const mockModelRuntimeCreate = vi.fn();
const mockModelRegistryCreate = vi.fn();
const mockSessionManagerCreate = vi.fn();
const mockSessionManagerList = vi.fn();
const mockSessionManagerOpen = vi.fn();
const mockGetAgentDir = vi.fn();
const mockCreateEventBus = vi.fn();
const mockDefaultResourceLoader = vi.fn();
const mockAppendCustomEntry = vi.fn();

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: mockModelRuntimeCreate,
  },
  ModelRegistry: class {
    constructor(runtime: unknown) {
      return mockModelRegistryCreate(runtime);
    }
  },
  SessionManager: {
    create: mockSessionManagerCreate,
    list: mockSessionManagerList,
    open: mockSessionManagerOpen,
  },
  createAgentSession: mockCreateAgentSession,
  createEventBus: mockCreateEventBus,
  DefaultResourceLoader: class {
    constructor(opts: Record<string, unknown>) {
      return mockDefaultResourceLoader(opts);
    }
  },
  getAgentDir: mockGetAgentDir,
  DEFAULT_COMPACTION_SETTINGS: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  stripFrontmatter: (content: string) => content,
}));

vi.mock('@earendil-works/pi-ai', () => ({}));

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'pi-session-1',
    sessionManager: { appendCustomEntry: mockAppendCustomEntry },
    resourceLoader: {
      getSkills: () => ({ skills: [] }),
      getPrompts: () => ({ prompts: [] }),
    },
    prompt: mockPrompt,
    subscribe: mockSubscribe,
    abort: mockAbort,
    compact: mockCompact,
    setThinkingLevel: mockSetThinkingLevel,
    bindExtensions: mockBindExtensions,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

describe('createPiRuntimeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetAgentDir.mockReturnValue('/home/ryan/.pi/agent');
    mockCreateEventBus.mockImplementation(() => ({ kind: 'event-bus' }));
    mockDefaultResourceLoader.mockImplementation((opts: Record<string, unknown>) => ({
      ...opts,
      reload: vi.fn().mockResolvedValue(undefined),
    }));
    mockModelRuntimeCreate.mockResolvedValue({ kind: 'model-runtime', setRuntimeApiKey: mockSetRuntimeApiKey });
    mockFind.mockReturnValue({ provider: 'anthropic', id: 'claude-sonnet-4-6' });
    mockModelRegistryCreate.mockReturnValue({ find: mockFind, registerProvider: vi.fn() });
    mockSessionManagerCreate.mockReturnValue({ kind: 'session-manager-create' });
    mockSessionManagerList.mockResolvedValue([]);
    mockSessionManagerOpen.mockReturnValue({ kind: 'session-manager-open' });
    mockCreateAgentSession.mockResolvedValue({ session: makeSession() });
    mockPrompt.mockResolvedValue(undefined);
    mockAbort.mockResolvedValue(undefined);
    mockCompact.mockResolvedValue({ ok: true });
    mockBindExtensions.mockResolvedValue(undefined);
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
    const modelRuntime = { kind: 'model-runtime', setRuntimeApiKey: mockSetRuntimeApiKey };
    expect(mockModelRuntimeCreate).toHaveBeenCalledWith({
      authPath: '/home/ryan/.pi/agent/auth.json',
      modelsPath: '/home/ryan/.pi/agent/models.json',
    });
    expect(mockModelRegistryCreate).toHaveBeenCalledWith(modelRuntime);
    expect(mockFind).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-6');
    expect(mockSessionManagerCreate).toHaveBeenCalledWith('/repo');
    expect(mockCreateAgentSession).toHaveBeenCalledWith({
      cwd: '/repo',
      agentDir: '/home/ryan/.pi/agent',
      modelRuntime,
      resourceLoader: expect.any(Object),
      sessionManager: { kind: 'session-manager-create' },
      model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      thinkingLevel: 'xhigh',
    });
    // Must bind extensions so the session_start event fires — extensions like
    // the MCP adapter initialize on it. Without this, MCP servers never connect.
    expect(mockBindExtensions).toHaveBeenCalledOnce();
  });

  it('gives each session an isolated policy loader and cleans legacy agent files without creating .pi', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    const legacyCwd = mkdtempSync(join(tmpdir(), 'orcd-policy-legacy-'));
    const cleanCwd = mkdtempSync(join(tmpdir(), 'orcd-policy-clean-'));
    const provider = {
      type: 'anthropic' as const,
      label: 'Trackable',
      baseUrl: 'http://127.0.0.1:3457',
      apiKey: 'trackable',
      models: {
        primary: { label: 'Primary', modelID: 'primary-id', contextWindow: 200_000 },
        subagent: { label: 'Subagent', modelID: 'subagent-id', contextWindow: 200_000 },
        lightweight: { label: 'Lightweight', modelID: 'lightweight-id', contextWindow: 200_000 },
      },
    };
    mkdirSync(join(legacyCwd, '.pi', 'agents'), { recursive: true });
    writeFileSync(join(legacyCwd, '.pi', 'agents', 'Explore.md'), '---\nmanaged_by: orchestrel\n---\nlegacy');

    try {
      await createPiRuntimeSession({ cwd: legacyCwd, providerId: 'trackable', modelId: 'primary', provider });
      await createPiRuntimeSession({ cwd: cleanCwd, providerId: 'trackable', modelId: 'primary', provider });

      expect(mockCreateEventBus).toHaveBeenCalledTimes(2);
      const loaderOptions = mockDefaultResourceLoader.mock.calls.map(([opts]) => opts);
      expect(loaderOptions[0].eventBus).not.toBe(loaderOptions[1].eventBus);
      expect(loaderOptions[0].extensionFactories).toHaveLength(1);
      expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({
        resourceLoader: expect.any(Object),
      }));
      expect(existsSync(join(legacyCwd, '.pi', 'agents', 'Explore.md'))).toBe(false);
      expect(existsSync(join(cleanCwd, '.pi'))).toBe(false);
    } finally {
      rmSync(legacyCwd, { recursive: true, force: true });
      rmSync(cleanCwd, { recursive: true, force: true });
    }
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

  it('registers a configured provider without auth for endpoints that accept anonymous requests', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    const registry = { find: mockFind, registerProvider: vi.fn() };
    mockModelRegistryCreate.mockReturnValue(registry);

    await createPiRuntimeSession({
      cwd: '/repo',
      providerId: 'ray',
      modelId: 'assistant',
      provider: {
        type: 'anthropic',
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: '',
        models: {
          assistant: { label: 'Assistant', modelID: 'assistant', contextWindow: 262_144 },
        },
      },
    });

    // Pi requires an apiKey when models are defined; orcd sends a placeholder
    // for auth-free endpoints (registration would throw otherwise).
    expect(registry.registerProvider).toHaveBeenCalledWith('ray', expect.objectContaining({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: expect.any(String),
    }));
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

  it('uses the native Google API for Gemini-compatible providers', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    const registry = { find: mockFind, registerProvider: vi.fn() };
    mockModelRegistryCreate.mockReturnValue(registry);

    await createPiRuntimeSession({
      cwd: '/repo',
      providerId: 'gemini',
      modelId: 'pro',
      provider: {
        type: 'google',
        label: 'Gemini',
        baseUrl: 'http://127.0.0.1:9877/v1beta',
        apiKey: 'proxy-key',
        models: {
          pro: { label: 'Gemini 3.1 Pro', modelID: 'gemini-3.1-pro-preview', contextWindow: 1048576 },
        },
      },
    });

    expect(registry.registerProvider).toHaveBeenCalledWith('gemini', expect.objectContaining({
      api: 'google-generative-ai',
      baseUrl: 'http://127.0.0.1:9877/v1beta',
      models: [expect.objectContaining({
        id: 'gemini-3.1-pro-preview',
        api: 'google-generative-ai',
      })],
    }));
    expect(mockFind).toHaveBeenCalledWith('gemini', 'gemini-3.1-pro-preview');
  });

  it('registers adaptive thinking (forceAdaptiveThinking + xhigh) when effort is adaptive', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    const registry = { find: mockFind, registerProvider: vi.fn() };
    mockModelRegistryCreate.mockReturnValue(registry);

    await createPiRuntimeSession({
      cwd: '/repo',
      providerId: 'kimi',
      modelId: 'k3',
      effort: 'adaptive',
      provider: {
        type: 'anthropic',
        label: 'Kimi',
        baseUrl: 'https://api.kimi.com/coding/',
        apiKey: 'sk-kimi-test',
        models: {
          k3: { label: 'K3 (1M)', modelID: 'k3', contextWindow: 1048576 },
        },
      },
    });

    expect(registry.registerProvider).toHaveBeenCalledWith('kimi', expect.objectContaining({
      models: [
        expect.objectContaining({
          id: 'k3',
          reasoning: true,
          compat: { forceAdaptiveThinking: true },
          thinkingLevelMap: { xhigh: 'xhigh' },
        }),
      ],
    }));
    expect(mockCreateAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      thinkingLevel: 'high',
    }));
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
    expect(mockAppendCustomEntry).not.toHaveBeenCalled();
  });

  it('persists the original slash command as display metadata before sending its expansion', async () => {
    const { createPiRuntimeSession } = await import('../pi-runtime');
    mockDefaultResourceLoader.mockImplementation((opts: Record<string, unknown>) => ({
      ...opts,
      reload: vi.fn().mockResolvedValue(undefined),
      getSkills: () => ({ skills: [] }),
      getPrompts: () => ({ prompts: [{ name: 'merge', content: 'Merge the current branch now.' }] }),
    }));
    mockCreateAgentSession.mockImplementation(async (opts: { resourceLoader: unknown }) => ({
      session: makeSession({ resourceLoader: opts.resourceLoader }),
    }));
    const session = await createPiRuntimeSession({ cwd: '/repo', providerId: 'anthropic', modelId: 'm' });

    await session.prompt('/merge');

    const expanded = mockPrompt.mock.calls[0][0] as string;
    expect(expanded).not.toBe('/merge');
    expect(mockAppendCustomEntry).toHaveBeenCalledWith('orchestrel-display-prompt', {
      displayText: '/merge',
      expandedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
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
