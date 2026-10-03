import { describe, expect, it, vi, beforeEach } from 'vitest';

const findCutPoint = vi.fn();
const generateSummary = vi.fn();
const appendCompaction = vi.fn(() => 'comp-id');
const buildSessionContext = vi.fn(() => ({ messages: ['m1', 'm2'] }));
const refreshContext = vi.fn();
const getBranch = vi.fn();
const agentState = { messages: [] as unknown[] };
let mockModel: Record<string, unknown> = { id: 'm', api: 'anthropic-messages' };

vi.mock('@earendil-works/pi-coding-agent', () => ({
  buildContextEntries: () => [],
  sessionEntryToContextMessages: () => [],
  findCutPoint: (...a: unknown[]) => findCutPoint(...a),
  generateSummary: (...a: unknown[]) => generateSummary(...a),
  DEFAULT_COMPACTION_SETTINGS: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  ModelRuntime: { create: async () => ({ setRuntimeApiKey: vi.fn() }) },
  ModelRegistry: class {
    registerProvider = vi.fn();
    find = () => mockModel;
    getApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: 'k', headers: {} }));
  },
  SessionManager: { create: () => ({}), open: () => ({}), list: vi.fn(async () => []) },
  SettingsManager: { create: () => ({ applyOverrides: () => undefined }) },
  createEventBus: () => ({}),
  DefaultResourceLoader: class {
    async reload() {}
  },
  createAgentSession: vi.fn(async () => ({
    session: {
      sessionId: 'sess-1',
      agent: { state: agentState, streamFn: undefined },
      sessionManager: { getBranch, appendCompaction, buildSessionContext, getEntries: () => [] },
      refreshContext,
      bindExtensions: vi.fn(async () => undefined),
      subscribe: () => () => undefined,
      messages: [],
    },
  })),
  getAgentDir: () => '/tmp/agent',
  stripFrontmatter: (content: string) => content,
}));

import { createPiRuntimeSession } from '../pi-runtime';

async function makeSession() {
  return createPiRuntimeSession({ cwd: '/tmp/x', providerId: 'anthropic', modelId: 'm' });
}

describe('pi-runtime BGC', () => {
  beforeEach(() => {
    findCutPoint.mockReset();
    generateSummary.mockReset();
    appendCompaction.mockReset();
    refreshContext.mockReset();
    getBranch.mockReset();
    agentState.messages = [];
    mockModel = { id: 'm', api: 'anthropic-messages' };
  });

  it('prepareBgCompaction returns null when there is no older half to summarize', async () => {
    getBranch.mockReturnValue([{ type: 'message', id: 'e0', message: { role: 'user' } }]);
    findCutPoint.mockReturnValue({ firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false });
    const s = await makeSession();
    const r = await s.prepareBgCompaction(100_000, new AbortController().signal);
    expect(r).toBeNull();
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it('summarizes the oldest entries and returns firstKeptEntryId from the cut', async () => {
    getBranch.mockReturnValue([
      { type: 'message', id: 'e0', message: { role: 'user', content: 'old' } },
      { type: 'message', id: 'e1', message: { role: 'assistant', content: 'keep' } },
    ]);
    findCutPoint.mockReturnValue({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
    generateSummary.mockResolvedValue('S');
    const s = await makeSession();
    const r = await s.prepareBgCompaction(100_000, new AbortController().signal);
    expect(r).toEqual({ summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 100_000, details: undefined });
    expect(findCutPoint).toHaveBeenCalledWith(expect.anything(), 0, 2, 20_000);
    expect(generateSummary.mock.calls[0][0]).toEqual([{ role: 'user', content: 'old' }]);
  });

  it('summarizes only the live context after the last compaction and merges the old summary', async () => {
    const entries = [
      { type: 'message', id: 'e0', message: { role: 'user', content: 'ancient' } },
      { type: 'compaction', id: 'c0', summary: 'OLD SUMMARY', firstKeptEntryId: 'e1' },
      { type: 'message', id: 'e1', message: { role: 'user', content: 'kept' } },
      { type: 'message', id: 'e2', message: { role: 'user', content: 'old half' } },
      { type: 'message', id: 'e3', message: { role: 'assistant', content: 'recent' } },
    ];
    getBranch.mockReturnValue(entries);
    findCutPoint.mockReturnValue({ firstKeptEntryIndex: 4, turnStartIndex: -1, isSplitTurn: false });
    generateSummary.mockResolvedValue('S');
    const s = await makeSession();
    const r = await s.prepareBgCompaction(100_000, new AbortController().signal);
    // Regression: the cut must start at the previous compaction's boundary. Starting at 0
    // re-feeds already-summarized messages ('ancient'), which overflows the summarizer
    // window and makes every BGC attempt fail.
    expect(findCutPoint).toHaveBeenCalledWith(entries, 2, 5, 20_000);
    expect(generateSummary.mock.calls[0][0]).toEqual([
      { role: 'user', content: 'kept' },
      { role: 'user', content: 'old half' },
    ]);
    expect(generateSummary.mock.calls[0][7]).toBe('OLD SUMMARY');
    // BGC never thinks, whatever the session's thinking level is.
    expect(generateSummary.mock.calls[0][8]).toBe('off');
    expect(r?.firstKeptEntryId).toBe('e3');
  });

  it('keeps the standard fixed tail whatever the live context size is', async () => {
    for (const tokens of [0, 100_000, 800_000]) {
      findCutPoint.mockReset();
      generateSummary.mockReset();
      getBranch.mockReturnValue([
        { type: 'message', id: 'e0', message: { role: 'user', content: 'old' } },
        { type: 'message', id: 'e1', message: { role: 'assistant', content: 'keep' } },
      ]);
      findCutPoint.mockReturnValue({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
      generateSummary.mockResolvedValue('S');
      const s = await makeSession();
      await s.prepareBgCompaction(tokens, new AbortController().signal);
      // 20,000 tokens, the same tail Pi's own compactor keeps — never a fraction of the
      // live context, which would leave 240k tokens behind on a large session.
      expect(findCutPoint).toHaveBeenCalledWith(expect.anything(), 0, 2, 20_000);
    }
    // No maxTokens on the model -> pi's default reserve, and therefore pi's 13,107-token cap.
    expect(generateSummary.mock.calls.at(-1)?.[2]).toBe(16_384);
  });

  it('gives the summarizer the model output budget instead of pi default reserve', async () => {
    // Regression: the default reserve (16,384) capped the summary at 13,107 tokens. A long
    // session outgrew it, every compaction failed on the cap, and BGC could never apply again.
    mockModel = { id: 'm', api: 'anthropic-messages', maxTokens: 64_000 };
    getBranch.mockReturnValue([
      { type: 'message', id: 'e0', message: { role: 'user', content: 'old' } },
      { type: 'message', id: 'e1', message: { role: 'assistant', content: 'keep' } },
    ]);
    findCutPoint.mockReturnValue({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
    generateSummary.mockResolvedValue('S');
    const s = await makeSession();
    await s.prepareBgCompaction(100_000, new AbortController().signal);
    // Pi caps the reply at floor(0.8 * reserveTokens), so 80,000 makes the cap the model's 64,000.
    expect(generateSummary.mock.calls[0][2]).toBe(80_000);
    // And the summary is given a hard ceiling: the pass otherwise grows until it hits the cap.
    expect(generateSummary.mock.calls[0][6]).toContain('under 8000 tokens');
  });

  it('applyBgCompaction appends the entry and refreshes the context', async () => {
    getBranch.mockReturnValue([
      { type: 'message', id: 'e0', message: { role: 'user' } },
      { type: 'message', id: 'e1', message: { role: 'assistant' } },
    ]);
    const s = await makeSession();
    const applied = s.applyBgCompaction({ summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 42, details: undefined });
    expect(applied).toBe(true);
    expect(appendCompaction).toHaveBeenCalledWith('S', 'e1', 42, undefined, true);
    expect(refreshContext).toHaveBeenCalledTimes(1);
  });

  it('refuses a cut a newer compaction has already superseded', async () => {
    // Regression: a splice prepared against the old boundary was applied after Pi
    // had compacted again, re-including summarized entries and pushing the live
    // context past the model's window.
    getBranch.mockReturnValue([
      { type: 'message', id: 'e0', message: { role: 'user' } },
      { type: 'message', id: 'e1', message: { role: 'assistant' } },
      { type: 'compaction', id: 'c1', firstKeptEntryId: 'e1', summary: 'NEWER' },
    ]);
    const s = await makeSession();
    const applied = s.applyBgCompaction({ summary: 'S', firstKeptEntryId: 'e0', tokensBefore: 42, details: undefined });
    expect(applied).toBe(false);
    expect(appendCompaction).not.toHaveBeenCalled();
    expect(refreshContext).not.toHaveBeenCalled();
  });
});
