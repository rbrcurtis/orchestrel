import { describe, expect, it } from 'vitest';
import { toClaudeCodeToolName, convertPiMessagesToAnthropic } from '../convert';

describe('claude code convert', () => {
  it('maps tool names to Claude Code spellings', () => {
    expect(toClaudeCodeToolName('read')).toBe('Read');
    expect(toClaudeCodeToolName('unknown_tool')).toBe('unknown_tool');
  });

  it('exports the message converter', () => {
    expect(typeof convertPiMessagesToAnthropic).toBe('function');
  });
});
