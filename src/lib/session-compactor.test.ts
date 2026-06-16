import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyCompaction, queryAgentSdk } from './session-compactor';

const events = vi.hoisted(() => [] as unknown[]);
const sdkControls = vi.hoisted(() => ({
  close: vi.fn(),
}));
const sdkQuery = vi.hoisted(() => vi.fn(() => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) yield event;
  },
  close: sdkControls.close,
})));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkQuery,
}));

describe('queryAgentSdk', () => {
  beforeEach(() => {
    events.length = 0;
    sdkQuery.mockClear();
    sdkControls.close.mockClear();
  });

  it('disables broken skills in Agent SDK options', async () => {
    events.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'done' }] },
    });

    await queryAgentSdk('prompt', 'model');

    expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        disallowedTools: expect.arrayContaining([
          'AskUserQuestion',
          'CronCreate',
          'CronDelete',
          'CronList',
          'ScheduleWakeup',
          'WebFetch',
          'WebSearch',
          'Workflow',
        ]),
        settings: expect.objectContaining({
          skillOverrides: expect.objectContaining({
            'claude-api': 'off',
          }),
        }),
      }),
    }));
  });

  it('closes and fails immediately when the Agent SDK reports a non-500 API retry', async () => {
    events.push({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 2,
      retry_delay_ms: 1000,
      error_status: 429,
      error: 'rate_limit',
    });

    await expect(queryAgentSdk('prompt', 'model')).rejects.toThrow('HTTP 429: rate_limit');
    expect(sdkControls.close).toHaveBeenCalledTimes(1);
  });

  it('closes and fails immediately when the Agent SDK retry has no HTTP status', async () => {
    events.push({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 2,
      retry_delay_ms: 1000,
      error: 'connection reset',
    });

    await expect(queryAgentSdk('prompt', 'model')).rejects.toThrow('connection error: connection reset');
    expect(sdkControls.close).toHaveBeenCalledTimes(1);
  });

  it('lets the Agent SDK retry HTTP 500+ API errors', async () => {
    events.push(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 2,
        retry_delay_ms: 1000,
        error_status: 503,
        error: 'overloaded',
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      },
    );

    await expect(queryAgentSdk('prompt', 'model')).resolves.toMatchObject({ text: 'done' });
    expect(sdkControls.close).not.toHaveBeenCalled();
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
