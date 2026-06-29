import { describe, expect, it, vi, beforeEach } from 'vitest';

const findCutPoint = vi.fn();
const generateSummary = vi.fn();
const appendCompaction = vi.fn(() => 'comp-id');
const buildSessionContext = vi.fn(() => ({ messages: ['m1', 'm2'] }));
const getBranch = vi.fn();
const agentState = { messages: [] as unknown[] };

vi.mock('@earendil-works/pi-coding-agent', () => ({
  findCutPoint: (...a: unknown[]) => findCutPoint(...a),
  generateSummary: (...a: unknown[]) => generateSummary(...a),
  DEFAULT_COMPACTION_SETTINGS: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  AuthStorage: { create: () => ({ setRuntimeApiKey: vi.fn() }) },
  ModelRegistry: { create: () => ({
    registerProvider: vi.fn(),
    find: () => ({ id: 'm', api: 'anthropic-messages' }),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'k', headers: {} })),
  }) },
  SessionManager: { create: () => ({}), open: () => ({}), list: vi.fn(async () => []) },
  createAgentSession: vi.fn(async () => ({
    session: {
      sessionId: 'sess-1',
      agent: { state: agentState, streamFn: undefined },
      sessionManager: { getBranch, appendCompaction, buildSessionContext },
      bindExtensions: vi.fn(async () => undefined),
      subscribe: () => () => undefined,
      messages: [],
    },
  })),
  getAgentDir: () => '/tmp/agent',
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
    getBranch.mockReset();
    agentState.messages = [];
  });

  it('prepareBgCompaction returns null when there is no older half to summarize', async () => {
    getBranch.mockReturnValue([{ type: 'message', id: 'e0', message: { role: 'user' } }]);
    findCutPoint.mockReturnValue({ firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false });
    const s = await makeSession();
    const r = await s.prepareBgCompaction(0.5, 100_000, new AbortController().signal);
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
    const r = await s.prepareBgCompaction(0.5, 100_000, new AbortController().signal);
    expect(r).toEqual({ summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 100_000, details: undefined });
    expect(findCutPoint).toHaveBeenCalledWith(expect.anything(), 0, 2, 50_000);
    expect(generateSummary.mock.calls[0][0]).toEqual([{ role: 'user', content: 'old' }]);
  });

  it('applyBgCompaction appends the entry and rebuilds messages', async () => {
    const s = await makeSession();
    await s.applyBgCompaction({ summary: 'S', firstKeptEntryId: 'e1', tokensBefore: 42, details: undefined });
    expect(appendCompaction).toHaveBeenCalledWith('S', 'e1', 42, undefined, true);
    expect(agentState.messages).toEqual(['m1', 'm2']);
  });
});
