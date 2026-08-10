import { describe, expect, it, vi } from 'vitest';
import { compact } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createOrchestrelFullCompactionExtension } from './orchestrel-full-compaction';

vi.mock('@earendil-works/pi-coding-agent', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return { ...original, compact: vi.fn() };
});

describe('full compaction extension', () => {
  it('uses the configured model for manual compaction and leaves automatic compaction unchanged', async () => {
    let handler: ((event: Record<string, unknown>) => Promise<unknown>) | undefined;
    const pi = {
      on: vi.fn((_name: string, cb: typeof handler) => { handler = cb; }),
    } as unknown as ExtensionAPI;
    const model = { provider: 'ray', id: 'assistant' } as never;
    const modelRegistry = {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'local', headers: { x: 'y' } }),
    } as never;
    vi.mocked(compact).mockResolvedValue({
      summary: 'summary',
      firstKeptEntryId: 'entry',
      tokensBefore: 100,
    });
    createOrchestrelFullCompactionExtension({ modelRegistry, model, timeoutMs: 10_000 })(pi);

    expect(await handler?.({ reason: 'threshold' })).toBeUndefined();
    const preparation = { firstKeptEntryId: 'entry', tokensBefore: 100 };
    const result = await handler?.({
      reason: 'manual', preparation, customInstructions: 'focus', signal: new AbortController().signal,
    });

    expect(compact).toHaveBeenCalledWith(
      preparation, model, 'local', { x: 'y' }, 'focus', expect.any(AbortSignal), 'off', undefined, undefined,
    );
    expect(result).toEqual({ compaction: expect.objectContaining({ summary: 'summary' }) });
  });

  it('cancels instead of falling back when the configured model fails', async () => {
    vi.mocked(compact).mockClear();
    let handler: ((event: Record<string, unknown>) => Promise<unknown>) | undefined;
    const pi = { on: vi.fn((_name: string, cb: typeof handler) => { handler = cb; }) } as unknown as ExtensionAPI;
    const modelRegistry = {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: false, error: 'no auth' }),
    } as never;
    createOrchestrelFullCompactionExtension({ modelRegistry, model: {} as never, timeoutMs: 10_000 })(pi);

    await expect(handler?.({
      reason: 'manual', preparation: {}, signal: new AbortController().signal,
    })).resolves.toEqual({ cancel: true });
    expect(compact).not.toHaveBeenCalled();
  });
});
