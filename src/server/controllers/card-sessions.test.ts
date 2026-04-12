import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from '../bus';

// Mock DB so handler doesn't throw on Card operations
vi.mock('../models/index', () => ({
  AppDataSource: {
    getRepository: () => ({
      findOneBy: vi.fn().mockResolvedValue({ id: 42, sessionId: 'sess-abc', contextTokens: 0, contextWindow: 200000, turnsCompleted: 0, updatedAt: '', save: vi.fn() }),
      save: vi.fn().mockResolvedValue(undefined),
    }),
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
