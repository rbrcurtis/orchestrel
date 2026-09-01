import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api, AssistantMessage, Model, ToolCall } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { MemoryServer } from './memory-api';
import { consolidate } from './consolidate';

const SERVER: MemoryServer = { apiUrl: 'http://mem.test', apiKey: 'k', project: 'trackable' };

const MODEL = { provider: 'max', id: 'qwen3.8-27b-oq8' } as unknown as Model<Api>;

function assistant(content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>, stop: string): AssistantMessage {
  return {
    role: 'assistant',
    content: content.map((c) => ({ ...c, type: c.type } as AssistantMessage['content'][number])),
    api: 'anthropic-messages',
    provider: 'max',
    model: 'qwen3.8-27b-oq8',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: stop === 'stop' ? 'stop' : 'toolUse',
    timestamp: 1,
  };
}

function toolCall(name: string, args: unknown): ToolCall {
  return { type: 'toolCall', id: `c-${name}`, name, arguments: args as Record<string, unknown> };
}

describe('consolidate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records store/update/delete as ops in stage mode without calling the API', async () => {
    // search_memory executes via fetch in stage mode (it must search to dedupe); store/update/delete are recorded only.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }), text: () => Promise.resolve('') }));
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        assistant([
          toolCall('search_memory', { query: 'retry' }),
          toolCall('store_memory', { title: 'Retry policy', text: 'Use backoff.', tags: ['infra'] }),
          toolCall('update_memory', { id: '9', text: 'new' }),
        ], 'toolUse'),
      )
      .mockResolvedValueOnce(assistant([{ type: 'text', text: 'done' }], 'stop'));
    const runtime = { completeSimple: complete } as unknown as ModelRuntime;

    const ops = await consolidate({
      excerpt: { sessionId: 's1', cwd: '/x', startedAt: '', text: 'session text', tokenEstimate: 5 },
      server: SERVER,
      runtime,
      model: MODEL,
      maxTurns: 10,
      mode: 'stage',
    });

    expect(ops).toEqual([
      { op: 'store', title: 'Retry policy', text: 'Use backoff.', tags: ['infra'] },
      { op: 'update', id: '9', text: 'new' },
    ]);
    // search executed; store/update/delete did NOT hit the API in stage mode
    expect(complete).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('executes search and stops when the model makes no tool calls', async () => {
    const complete = vi.fn().mockResolvedValueOnce(assistant([{ type: 'text', text: 'no ops needed' }], 'stop'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }), text: () => Promise.resolve('') }));
    const ops = await consolidate({
      excerpt: { sessionId: 's1', cwd: '/x', startedAt: '', text: 't', tokenEstimate: 1 },
      server: SERVER,
      runtime: { completeSimple: complete } as unknown as ModelRuntime,
      model: MODEL,
      maxTurns: 10,
      mode: 'stage',
    });
    expect(ops).toEqual([]);
    vi.unstubAllGlobals();
  });
});
