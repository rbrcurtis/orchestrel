import { describe, expect, it, vi } from 'vitest';
import { queryAgentSdk } from './session-compactor';

const sdkQuery = vi.hoisted(() => vi.fn(() => ({
  async *[Symbol.asyncIterator]() {
    yield {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'done' }] },
    };
  },
})));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkQuery,
}));

describe('queryAgentSdk', () => {
  it('disables broken skills in Agent SDK options', async () => {
    await queryAgentSdk('prompt', 'model');

    expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        disallowedTools: expect.arrayContaining(['AskUserQuestion']),
        settings: expect.objectContaining({
          skillOverrides: expect.objectContaining({
            'claude-api': 'off',
          }),
        }),
      }),
    }));
  });
});
