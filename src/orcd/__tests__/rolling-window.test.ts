import { describe, it, expect, vi } from 'vitest';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { createRollingWindowExtension } from '../extensions/rolling-window';

// ─── helpers ──────────────────────────────────────────────────────────────────

function userMsg(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 0 } as AgentMessage;
}

function assistantMsg(text: string, outputTokens = 0): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: {
      input: 0,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    timestamp: 0,
  } as AgentMessage;
}

// ─── test setup ───────────────────────────────────────────────────────────────

function makeMockRuntime() {
  let contextHandler: ((event: unknown) => unknown) | undefined;
  const mockRuntime = {
    on: vi.fn((event: string, handler: (event: unknown) => unknown) => {
      if (event === 'context') contextHandler = handler;
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
  return { mockRuntime, getContextHandler: () => contextHandler };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('createRollingWindowExtension', () => {
  it('returns a factory function', () => {
    const factory = createRollingWindowExtension({ messageBudgetTokens: 10_000 });
    expect(typeof factory).toBe('function');
  });

  it('factory registers a context event handler on the runtime', () => {
    const { mockRuntime } = makeMockRuntime();
    const factory = createRollingWindowExtension({ messageBudgetTokens: 10_000 });
    factory(mockRuntime);
    expect((mockRuntime.on as ReturnType<typeof vi.fn>).mock.calls.some(
      (args: unknown[]) => args[0] === 'context',
    )).toBe(true);
  });

  it('context handler passes messages through unchanged when under budget', async () => {
    const { mockRuntime, getContextHandler } = makeMockRuntime();
    const factory = createRollingWindowExtension({ messageBudgetTokens: 100_000 });
    factory(mockRuntime);

    const msgs = [userMsg('hi'), assistantMsg('hello', 10)];
    const result = await getContextHandler()!({ type: 'context', messages: msgs });
    expect((result as { messages: AgentMessage[] }).messages).toEqual(msgs);
  });

  it('context handler filters messages when over budget', async () => {
    const { mockRuntime, getContextHandler } = makeMockRuntime();
    // Very small budget forces eviction
    const factory = createRollingWindowExtension({
      messageBudgetTokens: 50,
      evictionRatio: 0.25,
      minTurnsKept: 1,
    });
    factory(mockRuntime);

    // 5 turns with large content each ~400 tokens — well over 50-token budget
    const bigText = 'a'.repeat(700); // ~200 tokens
    const msgs: AgentMessage[] = [
      userMsg(bigText), assistantMsg('x', 200),
      userMsg(bigText), assistantMsg('x', 200),
      userMsg(bigText), assistantMsg('x', 200),
      userMsg(bigText), assistantMsg('x', 200),
      userMsg(bigText), assistantMsg('x', 200),
    ];

    const result = await getContextHandler()!({ type: 'context', messages: msgs });
    expect((result as { messages: AgentMessage[] }).messages.length).toBeLessThan(msgs.length);
  });

  it('onEviction callback is called when eviction happens', async () => {
    const { mockRuntime, getContextHandler } = makeMockRuntime();
    const onEviction = vi.fn();
    const factory = createRollingWindowExtension({
      messageBudgetTokens: 50,
      evictionRatio: 0.25,
      minTurnsKept: 1,
      onEviction,
    });
    factory(mockRuntime);

    const bigText = 'a'.repeat(700);
    const msgs: AgentMessage[] = [
      userMsg(bigText), assistantMsg('x', 200),
      userMsg(bigText), assistantMsg('x', 200),
      userMsg(bigText), assistantMsg('x', 200),
    ];

    await getContextHandler()!({ type: 'context', messages: msgs });
    expect(onEviction).toHaveBeenCalledOnce();
    const [evictedCount, remainingCount] = onEviction.mock.calls[0] as [number, number];
    expect(evictedCount).toBeGreaterThan(0);
    expect(remainingCount).toBeGreaterThan(0);
  });

  it('onEviction callback NOT called when no eviction', async () => {
    const { mockRuntime, getContextHandler } = makeMockRuntime();
    const onEviction = vi.fn();
    const factory = createRollingWindowExtension({
      messageBudgetTokens: 100_000,
      onEviction,
    });
    factory(mockRuntime);

    const msgs = [userMsg('hi'), assistantMsg('hello', 10)];
    await getContextHandler()!({ type: 'context', messages: msgs });
    expect(onEviction).not.toHaveBeenCalled();
  });
});
