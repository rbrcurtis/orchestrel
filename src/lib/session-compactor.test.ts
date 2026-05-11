import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyCompaction, queryAgentSdk } from './session-compactor';

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

describe('applyCompaction', () => {
  it('writes a Claude-native summary wrapper after compact_boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrel-session-compactor-'));
    const jsonlPath = join(dir, 'session.jsonl');

    try {
      await writeFile(jsonlPath, [
        JSON.stringify({
          parentUuid: null,
          type: 'user',
          message: { role: 'user', content: 'old user message' },
          uuid: 'old-user',
          timestamp: '2026-05-10T00:00:00.000Z',
          sessionId: 'sess-1',
          version: '2.1.138',
        }),
        JSON.stringify({
          parentUuid: 'old-user',
          type: 'assistant',
          message: { role: 'assistant', content: 'old assistant message' },
          uuid: 'old-assistant',
          timestamp: '2026-05-10T00:00:01.000Z',
          sessionId: 'sess-1',
          version: '2.1.138',
        }),
        JSON.stringify({
          parentUuid: 'old-assistant',
          type: 'user',
          message: { role: 'user', content: 'newest kept message' },
          uuid: 'new-user',
          timestamp: '2026-05-10T00:00:02.000Z',
          sessionId: 'sess-1',
          version: '2.1.138',
        }),
      ].join('\n') + '\n');

      await applyCompaction({
        sessionId: 'sess-1',
        jsonlPath,
        summary: 'Summary body here.',
        lastOldLineIdx: 1,
        messagesBefore: 3,
        messagesCovered: 2,
        summaryChars: 18,
        prepareDurationMs: 0,
      });

      const lines = (await readFile(jsonlPath, 'utf-8')).trim().split('\n');
      const boundary = JSON.parse(lines[2]) as Record<string, unknown>;
      const summary = JSON.parse(lines[3]) as Record<string, unknown>;

      expect(boundary).toEqual(expect.objectContaining({
        type: 'system',
        subtype: 'compact_boundary',
      }));
      expect(summary).toEqual(expect.objectContaining({
        parentUuid: boundary.uuid,
        type: 'user',
      }));
      expect((summary.message as { content: string }).content).toBe(
        'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\nSummary body here.',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
