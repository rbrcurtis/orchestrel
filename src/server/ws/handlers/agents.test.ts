import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCompact = vi.fn();
const mockFindOneBy = vi.fn();

vi.mock('../../models/Card', () => ({
  Card: {
    findOneBy: mockFindOneBy,
  },
  CardSubscriber: class {},
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
  });

  it('forwards manual compaction requests to orcd', async () => {
    const { handleAgentCompact } = await import('./agents');
    const callback = vi.fn();
    mockFindOneBy.mockResolvedValue({ id: 42, sessionId: 'sess-abc' });

    await handleAgentCompact({ cardId: 42 }, callback);

    expect(callback).toHaveBeenCalledWith({});
    expect(mockCompact).toHaveBeenCalledWith('sess-abc');
  });
});
