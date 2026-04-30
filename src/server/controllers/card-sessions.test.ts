import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from '../bus';

const mockCards = [
  { id: 42, sessionId: 'sess-abc', column: 'running', contextTokens: 0, contextWindow: 200000, turnsCompleted: 0, updatedAt: '', save: vi.fn() },
];
const mockRepo = {
  findOneBy: vi.fn(async (where: { id?: number; sessionId?: string }) => {
    if (where.id !== undefined) return mockCards.find((card) => card.id === where.id) ?? null;
    if (where.sessionId !== undefined) return mockCards.find((card) => card.sessionId === where.sessionId) ?? null;
    return null;
  }),
  find: vi.fn(async () => mockCards),
  save: vi.fn(async (card: (typeof mockCards)[number]) => card),
};

vi.mock('../models/index', () => ({
  AppDataSource: {
    getRepository: () => mockRepo,
  },
}));
vi.mock('../models/Card', () => ({
  Card: { findOneBy: vi.fn().mockResolvedValue(null), find: vi.fn().mockResolvedValue([]) },
}));

// We test the routing concept: orcd messages for a tracked session
// should be published to the correct card's bus topics.

describe('orcd message router', () => {
  let bus: MessageBus;
  let handler: ((msg: unknown) => void) | null;

  // Minimal mock OrcdClient — captures the onMessage handler
  const mockClient = {
    onMessage: vi.fn((h: (msg: unknown) => void) => { handler = h; }),
    offMessage: vi.fn(),
  };

  beforeEach(() => {
    vi.resetModules();
    mockCards.splice(0, mockCards.length, {
      id: 42,
      sessionId: 'sess-abc',
      column: 'running',
      contextTokens: 0,
      contextWindow: 200000,
      turnsCompleted: 0,
      updatedAt: '',
      save: vi.fn(),
    });
    mockRepo.findOneBy.mockClear();
    mockRepo.find.mockClear();
    mockRepo.save.mockClear();
    bus = new MessageBus();
    handler = null;
    mockClient.onMessage.mockClear();
    mockClient.offMessage.mockClear();
  });

  it('routes stream_event to card:N:sdk bus topic', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    const sdkSpy = vi.fn();
    bus.on('card:42:sdk', sdkSpy);

    handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 0,
      event: { type: 'assistant', message: 'hello' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(sdkSpy).toHaveBeenCalledWith({ type: 'assistant', message: 'hello' });
  });

  it('ignores messages for untracked sessions', async () => {
    const { initOrcdRouter } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);

    const sdkSpy = vi.fn();
    bus.on('card:99:sdk', sdkSpy);

    handler!({
      type: 'stream_event',
      sessionId: 'unknown-sess',
      eventIndex: 0,
      event: { type: 'assistant', message: 'hello' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(sdkSpy).not.toHaveBeenCalled();
  });

  it('routes session_exit by DB session_id when in-memory mapping is missing', async () => {
    const { initOrcdRouter } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);

    const exitSpy = vi.fn();
    bus.on('card:42:exit', exitSpy);

    handler!({
      type: 'session_exit',
      sessionId: 'sess-abc',
      state: 'completed',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(exitSpy).toHaveBeenCalledWith({
      sessionId: 'sess-abc',
      status: 'completed',
    });
  });

  it('does not reset context tokens when background compaction starts', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');
    mockCards[0].contextTokens = 50000;

    handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 0,
      event: { type: 'system', subtype: 'bgc_started', session_id: 'sess-abc' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockCards[0].contextTokens).toBe(50000);
    expect(mockRepo.save).not.toHaveBeenCalled();
  });

  it('sets context tokens to sentinel 1 when compaction is applied', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');
    mockCards[0].contextTokens = 50000;

    handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 0,
      event: { type: 'system', subtype: 'compact_boundary', session_id: 'sess-abc' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockCards[0].contextTokens).toBe(1);
    expect(mockRepo.save).toHaveBeenCalled();
  });

  it('routes context_usage to card:N:context bus topic', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    const ctxSpy = vi.fn();
    bus.on('card:42:context', ctxSpy);

    handler!({
      type: 'context_usage',
      sessionId: 'sess-abc',
      contextTokens: 50000,
      contextWindow: 200000,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(ctxSpy).toHaveBeenCalledWith({
      contextTokens: 50000,
      contextWindow: 200000,
    });
  });

  it('does not treat task notifications as card completion', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    const exitSpy = vi.fn();
    const sdkSpy = vi.fn();
    bus.on('card:42:exit', exitSpy);
    bus.on('card:42:sdk', sdkSpy);

    handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 1,
      event: { type: 'task_notification', task_id: 'agent-123', status: 'completed', result: 'DONE' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(sdkSpy).toHaveBeenCalledWith({
      type: 'task_notification',
      task_id: 'agent-123',
      status: 'completed',
      result: 'DONE',
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('untrackSession stops routing', async () => {
    const { initOrcdRouter, trackSession, untrackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');
    untrackSession('sess-abc');

    const sdkSpy = vi.fn();
    bus.on('card:42:sdk', sdkSpy);

    handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 0,
      event: { type: 'assistant', message: 'hello' },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(sdkSpy).not.toHaveBeenCalled();
  });
});

describe('reconcileRunningCards', () => {
  it('moves running cards to review when orcd only lists stopped session', async () => {
    const { reconcileRunningCards } = await import('./card-sessions');
    const bus = new MessageBus();
    const exitSpy = vi.fn();
    bus.on('card:42:exit', exitSpy);
    const client = {
      list: vi.fn(async () => ({
        type: 'session_list',
        sessions: [{ id: 'sess-abc', state: 'stopped', cwd: '/tmp' }],
      })),
      markActive: vi.fn(),
    };

    await reconcileRunningCards(client as never, bus);

    expect(client.markActive).not.toHaveBeenCalled();
    expect(mockCards[0].column).toBe('review');
    expect(exitSpy).toHaveBeenCalledWith({
      sessionId: 'sess-abc',
      status: 'stopped',
    });
  });
});
