import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCompact = vi.fn();
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
  }),
}));

describe('handleAgentCompact', () => {
  beforeEach(() => {
    mockCompact.mockReset();
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
