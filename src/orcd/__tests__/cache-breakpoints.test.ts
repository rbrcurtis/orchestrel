import { describe, it, expect, vi } from 'vitest';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { injectBreakpoints, createCacheBreakpointExtension } from '../extensions/cache-breakpoints';

// ─── helpers ──────────────────────────────────────────────────────────────────

type TextBlock = { type: string; text?: string; cache_control?: { type: string } };
type Message = { role: string; content: string | TextBlock[] };

function makePayload(
  systemBlocks: TextBlock[],
  messages: Message[],
): unknown {
  return { system: systemBlocks, messages, model: 'claude-3-5-sonnet', max_tokens: 8192 };
}

function textBlock(text = 'hello'): TextBlock {
  return { type: 'text', text };
}

function userMsg(text = 'hi'): Message {
  return { role: 'user', content: [textBlock(text)] };
}

function assistantMsg(text = 'hello'): Message {
  return { role: 'assistant', content: [textBlock(text)] };
}

// ─── injectBreakpoints tests ───────────────────────────────────────────────────

describe('injectBreakpoints', () => {
  it('adds cache_control to the last system block', () => {
    const payload = makePayload([textBlock('sys1'), textBlock('sys2')], [userMsg()]);
    injectBreakpoints(payload, { stableBoundaryIndex: 0 });

    const p = payload as { system: TextBlock[]; messages: Message[] };
    expect(p.system[1].cache_control).toEqual({ type: 'ephemeral' });
    // First system block unchanged
    expect(p.system[0].cache_control).toBeUndefined();
  });

  it('adds cache_control at stable boundary message', () => {
    const payload = makePayload(
      [textBlock('sys')],
      [userMsg('u1'), assistantMsg('a1'), userMsg('u2')],
    );
    // stableBoundaryIndex=1 → add to messages[0] (last content block)
    injectBreakpoints(payload, { stableBoundaryIndex: 1 });

    const p = payload as { system: TextBlock[]; messages: Message[] };
    const firstMsgContent = p.messages[0].content as TextBlock[];
    expect(firstMsgContent[firstMsgContent.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('adds cache_control to the last user message', () => {
    const payload = makePayload(
      [textBlock('sys')],
      [userMsg('u1'), assistantMsg('a1'), userMsg('u2')],
    );
    injectBreakpoints(payload, { stableBoundaryIndex: 0 });

    const p = payload as { system: TextBlock[]; messages: Message[] };
    // Last user message is messages[2]
    const lastUserContent = p.messages[2].content as TextBlock[];
    expect(lastUserContent[lastUserContent.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does not add more than 4 total breakpoints', () => {
    // 5-message history with stableBoundaryIndex=2 → would produce 3 breakpoints
    // Even if payload already has 3 breakpoints marked, we check total never exceeds 4
    const payload = makePayload(
      [textBlock('sys')],
      [
        userMsg('u1'),
        assistantMsg('a1'),
        userMsg('u2'),
        assistantMsg('a2'),
        userMsg('u3'),
      ],
    );
    injectBreakpoints(payload, { stableBoundaryIndex: 2 });

    const p = payload as { system: TextBlock[]; messages: Message[] };
    let breakpointCount = 0;
    for (const block of p.system) {
      if (block.cache_control) breakpointCount++;
    }
    for (const msg of p.messages) {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.cache_control) breakpointCount++;
        }
      }
    }
    expect(breakpointCount).toBeLessThanOrEqual(4);
  });

  it('skips injection for non-Anthropic payloads (no system array)', () => {
    const payload = { messages: [{ role: 'user', content: 'hello' }] };
    const original = JSON.stringify(payload);
    injectBreakpoints(payload, { stableBoundaryIndex: 0 });
    // Payload should be unchanged
    expect(JSON.stringify(payload)).toBe(original);
  });

  it('handles empty messages array', () => {
    const payload = makePayload([textBlock('sys')], []);
    // Should not throw, only system breakpoint added
    expect(() => injectBreakpoints(payload, { stableBoundaryIndex: 0 })).not.toThrow();

    const p = payload as { system: TextBlock[]; messages: Message[] };
    expect(p.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles stableBoundaryIndex of 0 (no stable boundary breakpoint)', () => {
    const payload = makePayload(
      [textBlock('sys')],
      [userMsg('u1'), assistantMsg('a1'), userMsg('u2')],
    );
    injectBreakpoints(payload, { stableBoundaryIndex: 0 });

    const p = payload as { system: TextBlock[]; messages: Message[] };
    // messages[0] should NOT have a cache_control (stable boundary skipped)
    const firstMsgContent = p.messages[0].content as TextBlock[];
    expect(firstMsgContent[firstMsgContent.length - 1].cache_control).toBeUndefined();
    // messages[1] should also NOT have one
    const secondMsgContent = p.messages[1].content as TextBlock[];
    expect(secondMsgContent[secondMsgContent.length - 1].cache_control).toBeUndefined();
    // Last user message (messages[2]) SHOULD have one
    const lastUserContent = p.messages[2].content as TextBlock[];
    expect(lastUserContent[lastUserContent.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });
});

// ─── createCacheBreakpointExtension tests ──────────────────────────────────────

function makeMockRuntime() {
  let beforeProviderHandler: ((event: unknown) => unknown) | undefined;
  const mockRuntime = {
    on: vi.fn((event: string, handler: (event: unknown) => unknown) => {
      if (event === 'before_provider_request') beforeProviderHandler = handler;
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
  return { mockRuntime, getBeforeProviderHandler: () => beforeProviderHandler };
}

describe('createCacheBreakpointExtension', () => {
  it('returns a factory function', () => {
    const factory = createCacheBreakpointExtension();
    expect(typeof factory).toBe('function');
  });

  it('registers a before_provider_request handler on the runtime', () => {
    const { mockRuntime } = makeMockRuntime();
    const factory = createCacheBreakpointExtension();
    factory(mockRuntime);
    expect((mockRuntime.on as ReturnType<typeof vi.fn>).mock.calls.some(
      ([event]: [string]) => event === 'before_provider_request',
    )).toBe(true);
  });

  it('handler modifies Anthropic payloads by injecting cache breakpoints', () => {
    const { mockRuntime, getBeforeProviderHandler } = makeMockRuntime();
    const factory = createCacheBreakpointExtension();
    factory(mockRuntime);

    const payload = makePayload([textBlock('sys')], [userMsg('hello')]);
    const result = getBeforeProviderHandler()!({ type: 'before_provider_request', payload });

    // Result should be the modified payload
    const p = (result ?? payload) as { system: TextBlock[]; messages: Message[] };
    expect(p.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});
