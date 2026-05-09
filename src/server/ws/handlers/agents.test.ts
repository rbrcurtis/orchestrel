import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCompact = vi.fn();
const mockIsActive = vi.fn();
const mockFindOneBy = vi.fn();
const mockEnsureWorktree = vi.fn();
const mockTrackSession = vi.fn();

vi.mock('../../models/Card', () => ({
  Card: {
    findOneBy: mockFindOneBy,
  },
  CardSubscriber: class {},
}));

vi.mock('../../sessions/worktree', () => ({
  ensureWorktree: mockEnsureWorktree,
}));

vi.mock('../../controllers/card-sessions', () => ({
  trackSession: mockTrackSession,
}));

vi.mock('../../init-state', () => ({
  getOrcdClient: () => ({
    compact: mockCompact,
    isActive: mockIsActive,
  }),
}));

describe('handleAgentCompact', () => {
  beforeEach(() => {
    mockCompact.mockReset();
    mockIsActive.mockReset();
    mockFindOneBy.mockReset();
    mockEnsureWorktree.mockReset();
    mockTrackSession.mockReset();
  });

  it('forwards manual compaction requests to orcd with session metadata', async () => {
    const { handleAgentCompact } = await import('./agents');
    const callback = vi.fn();
    mockFindOneBy.mockResolvedValue({
      id: 42,
      sessionId: 'sess-abc',
      provider: 'anthropic',
      model: 'sonnet',
      contextWindow: 200_000,
      summarizeThreshold: 0.6,
    });
    mockEnsureWorktree.mockResolvedValue('/tmp/project');

    await handleAgentCompact({ cardId: 42 }, callback);

    expect(callback).toHaveBeenCalledWith({});
    expect(mockTrackSession).toHaveBeenCalledWith(42, 'sess-abc');
    expect(mockCompact).toHaveBeenCalledWith({
      sessionId: 'sess-abc',
      cwd: '/tmp/project',
      provider: 'anthropic',
      model: 'sonnet',
      contextWindow: 200_000,
      summarizeThreshold: 0.6,
    });
  });
});

describe('handleAgentStatus', () => {
  beforeEach(() => {
    mockCompact.mockReset();
    mockIsActive.mockReset();
    mockFindOneBy.mockReset();
    mockEnsureWorktree.mockReset();
    mockTrackSession.mockReset();
  });

  it('keeps brand-new running cards in place while their first session is still starting', async () => {
    const { handleAgentStatus } = await import('./agents');
    const callback = vi.fn();
    const emit = vi.fn();
    const save = vi.fn();
    mockFindOneBy.mockResolvedValue({
      id: 42,
      column: 'running',
      sessionId: null,
      promptsSent: 0,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200_000,
      save,
    });

    await handleAgentStatus({ cardId: 42 }, callback, { emit } as never);

    expect(save).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('agent:status', expect.objectContaining({
      cardId: 42,
      active: false,
      status: 'starting',
      sessionId: null,
    }));
    expect(callback).toHaveBeenCalledWith({});
  });

  it('moves inactive running cards with an existing session to review and reports them as completed', async () => {
    const { handleAgentStatus } = await import('./agents');
    const callback = vi.fn();
    const emit = vi.fn();
    const save = vi.fn();
    const card = {
      id: 42,
      column: 'running',
      sessionId: 'sess-abc',
      promptsSent: 1,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200_000,
      updatedAt: '',
      save,
    };
    mockFindOneBy.mockResolvedValue(card);
    mockIsActive.mockReturnValue(false);

    await handleAgentStatus({ cardId: 42 }, callback, { emit } as never);

    expect(card.column).toBe('review');
    expect(save).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('agent:status', expect.objectContaining({
      cardId: 42,
      active: false,
      status: 'completed',
      sessionId: 'sess-abc',
    }));
    expect(callback).toHaveBeenCalledWith({});
  });

  it('moves auto-started inactive running cards with an existing session to review', async () => {
    const { handleAgentStatus } = await import('./agents');
    const callback = vi.fn();
    const emit = vi.fn();
    const save = vi.fn();
    const card = {
      id: 42,
      column: 'running',
      sessionId: 'sess-abc',
      promptsSent: 0,
      turnsCompleted: 1,
      contextTokens: 0,
      contextWindow: 200_000,
      updatedAt: '',
      save,
    };
    mockFindOneBy.mockResolvedValue(card);
    mockIsActive.mockReturnValue(false);

    await handleAgentStatus({ cardId: 42 }, callback, { emit } as never);

    expect(card.column).toBe('review');
    expect(save).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('agent:status', expect.objectContaining({
      cardId: 42,
      active: false,
      status: 'completed',
      sessionId: 'sess-abc',
    }));
    expect(callback).toHaveBeenCalledWith({});
  });
});
