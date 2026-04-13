import { describe, it, expect } from 'vitest';
import { ContextManager } from '../context/manager';
import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
} from '@oh-my-pi/pi-ai';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeUsage(output: number) {
  return {
    input: 0,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function userMsg(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistantMsg(text: string, outputTokens = 0): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: makeUsage(outputTokens),
    stopReason: 'stop',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    timestamp: 0,
  };
}

function assistantToolCall(toolId: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolId, name: 'read_file', arguments: { path: '/x' } }],
    usage: makeUsage(0),
    stopReason: 'toolUse',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    timestamp: 0,
  };
}

function toolResultMsg(toolId: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: toolId,
    toolName: 'read_file',
    content: [{ type: 'text', text: 'result' }],
    isError: false,
    timestamp: 0,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('ContextManager.parseTurns', () => {
  const mgr = new ContextManager({ messageBudgetTokens: 10_000, evictionRatio: 0.25, minTurnsKept: 2 });

  it('returns empty array for empty messages', () => {
    expect(mgr.parseTurns([])).toEqual([]);
  });

  it('groups a single user+assistant pair into one turn', () => {
    const msgs = [userMsg('hi'), assistantMsg('hello')];
    const turns = mgr.parseTurns(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0].messages).toEqual(msgs);
  });

  it('groups two user+assistant pairs into two turns', () => {
    const msgs = [
      userMsg('q1'), assistantMsg('a1'),
      userMsg('q2'), assistantMsg('a2'),
    ];
    const turns = mgr.parseTurns(msgs);
    expect(turns).toHaveLength(2);
    expect(turns[0].messages).toEqual([userMsg('q1'), assistantMsg('a1')]);
    expect(turns[1].messages).toEqual([userMsg('q2'), assistantMsg('a2')]);
  });

  it('keeps tool_use and tool_result in the same turn', () => {
    const msgs = [
      userMsg('use tool'),
      assistantToolCall('tc1'),
      toolResultMsg('tc1'),
      assistantMsg('done'),
    ];
    const turns = mgr.parseTurns(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0].messages).toHaveLength(4);
  });

  it('handles leading non-user messages as their own turn', () => {
    const msgs = [
      assistantMsg('preamble'),
      userMsg('q1'),
      assistantMsg('a1'),
    ];
    const turns = mgr.parseTurns(msgs);
    expect(turns).toHaveLength(2);
    expect(turns[0].messages).toEqual([assistantMsg('preamble')]);
    expect(turns[1].messages).toEqual([userMsg('q1'), assistantMsg('a1')]);
  });

  it('handles a single user message with no assistant reply', () => {
    const msgs = [userMsg('hi')];
    const turns = mgr.parseTurns(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0].messages).toEqual(msgs);
  });
});

describe('ContextManager.evict', () => {
  it('returns all messages unchanged when under budget', () => {
    const mgr = new ContextManager({ messageBudgetTokens: 100_000, evictionRatio: 0.25, minTurnsKept: 2 });
    const msgs = [userMsg('hi'), assistantMsg('hello')];
    const result = mgr.evict(msgs);
    expect(result.messages).toEqual(msgs);
    expect(result.evictedCount).toBe(0);
  });

  it('returns empty result for empty messages', () => {
    const mgr = new ContextManager({ messageBudgetTokens: 10_000, evictionRatio: 0.25, minTurnsKept: 2 });
    const result = mgr.evict([]);
    expect(result.messages).toEqual([]);
    expect(result.evictedCount).toBe(0);
    expect(result.stableBoundaryIndex).toBe(0);
  });

  it('evicts oldest turns when over budget', () => {
    // Each user msg "a"*700 = 200 tokens + 4 overhead = 204
    // Each assistant msg with 200 output tokens = 200 + 4 = 204
    // Each turn ≈ 408 tokens
    // 5 turns ≈ 2040 tokens
    // Budget = 600, target after eviction = 600 * 0.75 = 450
    // Need to evict turns until ≤ 450 tokens → keep at most 1 turn
    const bigText = 'a'.repeat(700); // 200 tokens
    const msgs = [
      userMsg(bigText), assistantMsg('x', 200),
      userMsg(bigText), assistantMsg('x', 200),
      userMsg(bigText), assistantMsg('x', 200),
      userMsg(bigText), assistantMsg('x', 200),
      userMsg(bigText), assistantMsg('x', 200),
    ];
    const mgr = new ContextManager({ messageBudgetTokens: 600, evictionRatio: 0.25, minTurnsKept: 1 });
    const result = mgr.evict(msgs);
    expect(result.evictedCount).toBeGreaterThan(0);
    // Should keep minTurnsKept turns at minimum — but with budget 600 and 1 turn = 408 tokens we can fit 1 turn
    expect(result.messages.length).toBeLessThan(msgs.length);
  });

  it('never evicts below minTurnsKept', () => {
    const bigText = 'a'.repeat(7000); // 2000 tokens
    const msgs = [
      userMsg(bigText), assistantMsg('x', 2000),
      userMsg(bigText), assistantMsg('x', 2000),
      userMsg(bigText), assistantMsg('x', 2000),
    ];
    // Budget so small it would want to evict everything, but minTurnsKept=2
    const mgr = new ContextManager({ messageBudgetTokens: 100, evictionRatio: 0.25, minTurnsKept: 2 });
    const result = mgr.evict(msgs);
    // Should keep at least 2 turns = 4 messages
    expect(result.messages.length).toBeGreaterThanOrEqual(4);
    const turns = mgr.parseTurns(result.messages);
    expect(turns.length).toBeGreaterThanOrEqual(2);
  });

  it('tool call integrity: never splits tool_use from tool_result across eviction boundary', () => {
    // Turn 1: user + assistant(toolCall) + toolResult + assistant(done)
    // Turn 2: user + assistant(reply)
    // We want turn 1 evicted but turn 2 kept — they should be cleanly separated
    const bigText = 'a'.repeat(700); // 200 tokens
    const turn1 = [
      userMsg(bigText),
      assistantToolCall('tc1'),
      toolResultMsg('tc1'),
      assistantMsg('done', 200),
    ];
    const turn2 = [userMsg('short'), assistantMsg('reply', 10)];
    const msgs = [...turn1, ...turn2];

    // Budget: just enough for turn2 but not turn1
    // turn1 ≈ 200+4 + 4+4 + 4+4 + 200+4 = ~424 tokens
    // turn2 ≈ 4 + 10+4 = ~22 tokens
    // Budget = 100, target = 75 → keep turn2 only
    const mgr = new ContextManager({ messageBudgetTokens: 100, evictionRatio: 0.25, minTurnsKept: 1 });
    const result = mgr.evict(msgs);
    // Either all of turn1 is kept or none of it — never partially split
    const kept = result.messages;
    // turn2 messages should always be present (they're the last turn)
    expect(kept).toEqual(expect.arrayContaining(turn2));
    // Check that if turn1 is partially present, all its messages are present together
    const hasTurn1Partial = kept.some(m => turn1.includes(m)) && !turn1.every(m => kept.includes(m));
    expect(hasTurn1Partial).toBe(false);
  });

  it('stableBoundaryIndex points to start of last turn', () => {
    const msgs = [
      userMsg('q1'), assistantMsg('a1'),   // turn 0: idx 0,1
      userMsg('q2'), assistantMsg('a2'),   // turn 1: idx 2,3
      userMsg('q3'), assistantMsg('a3'),   // turn 2: idx 4,5 — last turn
    ];
    const mgr = new ContextManager({ messageBudgetTokens: 100_000, evictionRatio: 0.25, minTurnsKept: 2 });
    const result = mgr.evict(msgs);
    // stableBoundaryIndex should be 4 (start of last turn)
    expect(result.stableBoundaryIndex).toBe(4);
  });

  it('stableBoundaryIndex is 0 for single turn', () => {
    const msgs = [userMsg('q1'), assistantMsg('a1')];
    const mgr = new ContextManager({ messageBudgetTokens: 100_000, evictionRatio: 0.25, minTurnsKept: 1 });
    const result = mgr.evict(msgs);
    expect(result.stableBoundaryIndex).toBe(0);
  });
});
