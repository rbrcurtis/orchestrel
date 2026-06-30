import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCompact = vi.fn();
const mockIsActive = vi.fn();
const mockCancel = vi.fn();
const mockFindOneBy = vi.fn();
const mockEnsureWorktree = vi.fn();
const mockTrackSession = vi.fn();
const mockJoinCard = vi.fn();

vi.mock('../subscriptions', () => ({
  busRoomBridge: { joinCard: mockJoinCard },
}));

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
    cancel: mockCancel,
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
      mode: 'background',
    });
  });
});

describe('handleAgentStop', () => {
  beforeEach(() => {
    mockCancel.mockReset();
    mockFindOneBy.mockReset();
  });

  it('cancels the live session for the card', async () => {
    const { handleAgentStop } = await import('./agents');
    const callback = vi.fn();
    mockFindOneBy.mockResolvedValue({ id: 42, sessionId: 'sess-abc' });

    await handleAgentStop({ cardId: 42 }, callback);

    expect(callback).toHaveBeenCalledWith({});
    expect(mockCancel).toHaveBeenCalledWith('sess-abc');
  });

  it('does not cancel when the card has no session', async () => {
    const { handleAgentStop } = await import('./agents');
    const callback = vi.fn();
    mockFindOneBy.mockResolvedValue({ id: 42, sessionId: null });

    await handleAgentStop({ cardId: 42 }, callback);

    expect(callback).toHaveBeenCalledWith({});
    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe('handleAgentStatus', () => {
  beforeEach(() => {
    mockCompact.mockReset();
    mockIsActive.mockReset();
    mockFindOneBy.mockReset();
    mockEnsureWorktree.mockReset();
    mockTrackSession.mockReset();
    mockJoinCard.mockReset();
  });

  // Regression guard for the silent BE→FE streaming drop: status polls (which
  // fire on every SessionView mount and on reconnect) must rejoin the card room
  // so a reconnected socket keeps receiving live events.
  it('rejoins the card room so a reconnected socket keeps receiving events', async () => {
    const { handleAgentStatus } = await import('./agents');
    const callback = vi.fn();
    const socket = { emit: vi.fn() };
    mockFindOneBy.mockResolvedValue({
      id: 42, column: 'review', sessionId: 'sess-abc', promptsSent: 1,
      turnsCompleted: 1, contextTokens: 0, contextWindow: 200_000, save: vi.fn(),
    });
    mockIsActive.mockReturnValue(false);

    await handleAgentStatus({ cardId: 42 }, callback, socket as never);

    expect(mockJoinCard).toHaveBeenCalledWith(socket, 42);
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
