import { beforeEach, describe, expect, it, vi } from 'vitest';

const historyMocks = vi.hoisted(() => ({
  getPiSessionMessages: vi.fn(),
}));

vi.mock('./pi-session-history', () => ({
  getPiSessionMessages: historyMocks.getPiSessionMessages,
}));

const zeroToolCalls = { search: 0, store: 0, update: 0, delete: 0 };

describe('buildMemoryExcerptFromHistory', () => {
  it('builds memory excerpts from Pi history-shaped messages', async () => {
    const { buildMemoryExcerptFromHistory } = await import('./memory-upsert');

    const result = buildMemoryExcerptFromHistory([
      { type: 'system', subtype: 'init', message: { role: 'system', content: 'ignore me' } },
      { type: 'custom', message: { role: 'notice', content: 'ignore unsupported' } },
      { type: 'user', message: { role: 'user', content: 'Remember this workflow' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Use the Pi history source.' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/src/lib/memory-upsert.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [{ type: 'text', text: 'file contents here' }],
            is_error: false,
          }],
        },
      },
    ], 10_000);

    expect(result.messagesProcessed).toBe(3);
    expect(result.excerpt).toContain('[user]: Remember this workflow');
    expect(result.excerpt).toContain('[assistant]: Use the Pi history source.');
    expect(result.excerpt).toContain('[tool_use: Read {"file_path":"/repo/src/lib/memory-upsert.ts"}]');
    expect(result.excerpt).toContain('[user]: [tool_result: file contents here]');
    expect(result.excerpt).not.toContain('ignore me');
    expect(result.excerpt).not.toContain('ignore unsupported');
  });

  it('counts only messages represented in the excerpt', async () => {
    const { buildMemoryExcerptFromHistory } = await import('./memory-upsert');

    const result = buildMemoryExcerptFromHistory([
      { type: 'user', message: { role: 'user', content: 'first message' } },
      { type: 'assistant', message: { role: 'assistant', content: 'second message should not fit' } },
    ], 25);

    expect(result.messagesProcessed).toBe(1);
    expect(result.excerpt).toContain('first message');
    expect(result.excerpt).not.toContain('second message');
  });
});

describe('upsertMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getPiSessionMessages and returns zero counters when there are no messages', async () => {
    const { upsertMemories } = await import('./memory-upsert');
    historyMocks.getPiSessionMessages.mockResolvedValue([]);

    const result = await upsertMemories({
      sessionId: 'session-empty',
      projectPath: '/repo',
      projectName: 'repo',
      model: 'test-model',
      memoryBaseUrl: 'http://memory.test',
      memoryApiKey: 'test-key',
    });

    expect(historyMocks.getPiSessionMessages).toHaveBeenCalledWith('session-empty', '/repo');
    expect(result.sessionId).toBe('session-empty');
    expect(result.messagesProcessed).toBe(0);
    expect(result.toolCalls).toEqual(zeroToolCalls);
    expect(result.turns).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns zero counters when Pi history exists but agent path is unavailable', async () => {
    const { upsertMemories } = await import('./memory-upsert');
    historyMocks.getPiSessionMessages.mockResolvedValue([
      { type: 'user', message: { role: 'user', content: 'Store a durable learning' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Learned it' }] } },
    ]);

    const result = await upsertMemories({
      sessionId: 'session-with-history',
      projectPath: '/repo',
      projectName: 'repo',
      model: 'test-model',
      env: { TEST_ENV: '1' },
      memoryBaseUrl: 'http://memory.test',
      memoryApiKey: 'test-key',
      maxTurns: 5,
    });

    expect(historyMocks.getPiSessionMessages).toHaveBeenCalledWith('session-with-history', '/repo');
    expect(result.sessionId).toBe('session-with-history');
    expect(result.messagesProcessed).toBe(2);
    expect(result.toolCalls).toEqual(zeroToolCalls);
    expect(result.turns).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
