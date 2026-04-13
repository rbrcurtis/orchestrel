import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessageTokens } from '../context/token-estimator';
import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
} from '@oh-my-pi/pi-ai';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates tokens using ~3.5 chars/token ratio', () => {
    // 35 chars / 3.5 = 10 tokens
    const text = 'a'.repeat(35);
    expect(estimateTokens(text)).toBe(10);
  });

  it('rounds down fractional token counts', () => {
    // 10 chars / 3.5 = 2.857 → 2
    expect(estimateTokens('a'.repeat(10))).toBe(2);
  });

  it('handles single character', () => {
    // 1 / 3.5 = 0.28 → 0
    expect(estimateTokens('a')).toBe(0);
  });
});

describe('estimateMessageTokens', () => {
  const BASE_OVERHEAD = 4;

  describe('UserMessage', () => {
    it('estimates string content', () => {
      const msg: UserMessage = {
        role: 'user',
        content: 'a'.repeat(70), // 70 / 3.5 = 20 tokens
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(20 + BASE_OVERHEAD);
    });

    it('estimates array content with text blocks', () => {
      const msg: UserMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'a'.repeat(35) }, // 10 tokens
          { type: 'text', text: 'b'.repeat(35) }, // 10 tokens
        ],
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(20 + BASE_OVERHEAD);
    });

    it('estimates image content at ~1000 tokens each', () => {
      const msg: UserMessage = {
        role: 'user',
        content: [
          { type: 'image', data: 'abc', mimeType: 'image/png' },
          { type: 'image', data: 'xyz', mimeType: 'image/jpeg' },
        ],
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(2000 + BASE_OVERHEAD);
    });

    it('estimates mixed text and image content', () => {
      const msg: UserMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'a'.repeat(35) }, // 10 tokens
          { type: 'image', data: 'abc', mimeType: 'image/png' }, // 1000 tokens
        ],
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(1010 + BASE_OVERHEAD);
    });
  });

  describe('AssistantMessage', () => {
    const makeUsage = (output: number) => ({
      input: 0,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });

    it('uses actual outputTokens when > 0', () => {
      const msg: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'short' }],
        usage: makeUsage(500),
        stopReason: 'stop',
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(500 + BASE_OVERHEAD);
    });

    it('falls back to char estimation when outputTokens is 0', () => {
      const msg: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'a'.repeat(35) }], // 10 tokens
        usage: makeUsage(0),
        stopReason: 'stop',
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(10 + BASE_OVERHEAD);
    });

    it('estimates thinking content via char heuristic when no usage', () => {
      const msg: AssistantMessage = {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'a'.repeat(35) }, // 10 tokens
          { type: 'text', text: 'b'.repeat(35) }, // 10 tokens
        ],
        usage: makeUsage(0),
        stopReason: 'stop',
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(20 + BASE_OVERHEAD);
    });

    it('estimates toolCall content by serializing arguments', () => {
      const msg: AssistantMessage = {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc1',
            name: 'read_file',
            arguments: { path: '/foo/bar' }, // JSON serializes to ~20 chars
          },
        ],
        usage: makeUsage(0),
        stopReason: 'toolUse',
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        timestamp: 0,
      };
      // name + JSON(arguments): "read_file" (9) + '{"path":"/foo/bar"}' (19) = 28 chars / 3.5 = 8 tokens
      const expected = Math.floor((9 + 19) / 3.5) + BASE_OVERHEAD;
      expect(estimateMessageTokens(msg)).toBe(expected);
    });

    it('ignores redactedThinking blocks (no text to estimate)', () => {
      const msg: AssistantMessage = {
        role: 'assistant',
        content: [
          { type: 'redactedThinking', data: 'opaque-blob' },
          { type: 'text', text: 'a'.repeat(35) }, // 10 tokens
        ],
        usage: makeUsage(0),
        stopReason: 'stop',
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(10 + BASE_OVERHEAD);
    });
  });

  describe('ToolResultMessage', () => {
    it('estimates text content', () => {
      const msg: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'a'.repeat(35) }], // 10 tokens
        isError: false,
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(10 + BASE_OVERHEAD);
    });

    it('estimates image content at ~1000 tokens each', () => {
      const msg: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'screenshot',
        content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
        isError: false,
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(1000 + BASE_OVERHEAD);
    });

    it('estimates mixed content', () => {
      const msg: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'multi',
        content: [
          { type: 'text', text: 'a'.repeat(35) }, // 10 tokens
          { type: 'image', data: 'img', mimeType: 'image/png' }, // 1000 tokens
        ],
        isError: false,
        timestamp: 0,
      };
      expect(estimateMessageTokens(msg)).toBe(1010 + BASE_OVERHEAD);
    });
  });
});
