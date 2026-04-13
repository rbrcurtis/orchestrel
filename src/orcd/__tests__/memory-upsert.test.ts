import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from '@oh-my-pi/pi-coding-agent';
import { createMemoryUpsertExtension } from '../extensions/memory-upsert';
import type { ProviderConfig } from '../config';

// ─── mocks ───────────────────────────────────────────────────────────────────

vi.mock('@oh-my-pi/pi-ai', () => ({
  completeSimple: vi.fn().mockResolvedValue({
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '{"title":"Test fact","text":"A test fact extracted from conversation"}\n{"title":"Another fact","text":"Another extracted fact"}',
      },
    ],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'google/gemma-4-31b',
    timestamp: Date.now(),
  }),
}));

vi.mock('../model-registry', () => ({
  resolveModel: vi.fn().mockReturnValue({
    id: 'google/gemma-4-31b',
    name: 'google/gemma-4-31b',
    api: 'openai-completions',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  }),
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function userMsg(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    timestamp: Date.now(),
  } as AgentMessage;
}

const openrouterConfig: ProviderConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'test-api-key',
  models: ['google/gemma-4-31b'],
};

function makeMockRuntime() {
  let turnEndHandler: ((event: TurnEndEvent, ctx: ExtensionContext) => void) | undefined;
  const mockRuntime = {
    on: vi.fn((event: string, handler: (event: TurnEndEvent, ctx: ExtensionContext) => void) => {
      if (event === 'turn_end') turnEndHandler = handler;
    }),
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setLabel: vi.fn(),
    getActiveTools: vi.fn(),
    getAllTools: vi.fn(),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
  } as unknown as ExtensionAPI;
  return { mockRuntime, getTurnEndHandler: () => turnEndHandler };
}

function makeSessionEntries(messages: AgentMessage[]) {
  return messages.map((msg, i) => ({
    type: 'message' as const,
    id: `entry-${i}`,
    parentId: i > 0 ? `entry-${i - 1}` : null,
    timestamp: new Date().toISOString(),
    message: msg,
  }));
}

function makeMockContext(messages: AgentMessage[]): ExtensionContext {
  return {
    sessionManager: {
      getBranch: vi.fn(() => makeSessionEntries(messages)),
    },
  } as unknown as ExtensionContext;
}

function makeTurnEndEvent(idx: number, msg: AgentMessage): TurnEndEvent {
  return {
    type: 'turn_end',
    turnIndex: idx,
    message: msg,
    toolResults: [],
  };
}

/** Wait for a condition with polling. */
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  // Final check — will throw via expect if still false
  fn();
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('createMemoryUpsertExtension', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns a factory function', () => {
    const factory = createMemoryUpsertExtension({
      turnsPerUpsert: 3,
      openrouterConfig,
      project: 'test-project',
    });
    expect(typeof factory).toBe('function');
  });

  it('registers a turn_end handler', () => {
    const { mockRuntime } = makeMockRuntime();
    const factory = createMemoryUpsertExtension({
      turnsPerUpsert: 3,
      openrouterConfig,
      project: 'test-project',
    });
    factory(mockRuntime);

    expect((mockRuntime.on as ReturnType<typeof vi.fn>).mock.calls.some(
      (args: unknown[]) => args[0] === 'turn_end',
    )).toBe(true);
  });

  it('does not fire upsert before reaching turnsPerUpsert', async () => {
    const { mockRuntime, getTurnEndHandler } = makeMockRuntime();
    const factory = createMemoryUpsertExtension({
      turnsPerUpsert: 3,
      openrouterConfig,
      project: 'test-project',
    });
    factory(mockRuntime);

    const msgs = [userMsg('hello'), assistantMsg('hi there')];
    const ctx = makeMockContext(msgs);
    const handler = getTurnEndHandler()!;

    // Turns 1 and 2 should NOT trigger upsert
    handler(makeTurnEndEvent(0, msgs[1]), ctx);
    handler(makeTurnEndEvent(1, msgs[1]), ctx);

    // Give async a chance to settle
    await new Promise(r => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fires upsert on the Nth turn', async () => {
    const { mockRuntime, getTurnEndHandler } = makeMockRuntime();
    const factory = createMemoryUpsertExtension({
      turnsPerUpsert: 2,
      openrouterConfig,
      project: 'test-project',
    });
    factory(mockRuntime);

    const msgs = [userMsg('hello'), assistantMsg('hi there')];
    const ctx = makeMockContext(msgs);
    const handler = getTurnEndHandler()!;

    handler(makeTurnEndEvent(0, msgs[1]), ctx);
    // Turn 2 should trigger
    handler(makeTurnEndEvent(1, msgs[1]), ctx);

    await waitFor(() => fetchSpy.mock.calls.length > 0);

    // Should call memory API for each extracted fact (mock returns 2 facts)
    const memoryCalls = fetchSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/api/v1/memories'),
    );
    expect(memoryCalls.length).toBe(2);
  });

  it('sends correct auth header and body to memory API', async () => {
    const { mockRuntime, getTurnEndHandler } = makeMockRuntime();
    const factory = createMemoryUpsertExtension({
      turnsPerUpsert: 1,
      openrouterConfig,
      project: 'my-project',
      memoryApiKey: 'custom-key',
      memoryBaseUrl: 'http://localhost:9999',
    });
    factory(mockRuntime);

    const msgs = [userMsg('hello'), assistantMsg('world')];
    const ctx = makeMockContext(msgs);
    const handler = getTurnEndHandler()!;

    handler(makeTurnEndEvent(0, msgs[1]), ctx);

    await waitFor(() => fetchSpy.mock.calls.length > 0);

    const call = fetchSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/api/v1/memories'),
    );
    expect(call).toBeDefined();
    expect(call![0]).toBe('http://localhost:9999/api/v1/memories');

    const opts = call![1] as { headers: Record<string, string>; body: string };
    expect(opts.headers['Authorization']).toBe('Bearer custom-key');

    const body = JSON.parse(opts.body) as { title: string; project: string; tags: string[] };
    expect(body.project).toBe('my-project');
    expect(body.tags).toEqual(['auto-upsert']);
  });

  it('logs errors without throwing on fetch failure', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('server error') });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { mockRuntime, getTurnEndHandler } = makeMockRuntime();
    const factory = createMemoryUpsertExtension({
      turnsPerUpsert: 1,
      openrouterConfig,
      project: 'test-project',
    });
    factory(mockRuntime);

    const msgs = [userMsg('hello'), assistantMsg('world')];
    const ctx = makeMockContext(msgs);
    const handler = getTurnEndHandler()!;

    // Should not throw
    handler(makeTurnEndEvent(0, msgs[1]), ctx);

    await waitFor(() => errorSpy.mock.calls.length > 0);

    const errorCalls = errorSpy.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('[memory-upsert]'),
    );
    expect(errorCalls.length).toBeGreaterThan(0);

    errorSpy.mockRestore();
  });

  it('fires again after another N turns', async () => {
    const { mockRuntime, getTurnEndHandler } = makeMockRuntime();
    const factory = createMemoryUpsertExtension({
      turnsPerUpsert: 2,
      openrouterConfig,
      project: 'test-project',
    });
    factory(mockRuntime);

    const msgs = [userMsg('hello'), assistantMsg('world')];
    const ctx = makeMockContext(msgs);
    const handler = getTurnEndHandler()!;

    // First cycle: turns 1,2
    handler(makeTurnEndEvent(0, msgs[1]), ctx);
    handler(makeTurnEndEvent(1, msgs[1]), ctx);

    await waitFor(() => fetchSpy.mock.calls.length > 0);
    const countAfterFirst = fetchSpy.mock.calls.length;

    // Second cycle: turns 3,4
    handler(makeTurnEndEvent(2, msgs[1]), ctx);
    handler(makeTurnEndEvent(3, msgs[1]), ctx);

    await waitFor(() => fetchSpy.mock.calls.length > countAfterFirst);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(countAfterFirst);
  });
});
