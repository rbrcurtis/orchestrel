import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from '../bus';

type MockCard = {
  id: number;
  sessionId: string | null;
  column: string;
  promptsSent: number;
  contextTokens: number;
  contextWindow: number;
  turnsCompleted: number;
  provider: string;
  model: string;
  nodeName: string;
  summarizeThreshold: number;
  updatedAt: string;
  save: ReturnType<typeof vi.fn>;
};

const mockCards: MockCard[] = [
  { id: 42, sessionId: 'sess-abc', column: 'running', promptsSent: 1, contextTokens: 0, contextWindow: 200000, turnsCompleted: 0, provider: 'anthropic', model: 'sonnet', nodeName: 'local', summarizeThreshold: 0.6, updatedAt: '', save: vi.fn() },
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
const mockEnsureWorktree = vi.fn(async () => '/tmp/project/.worktrees/card-42');
const mockGetOrcdClient = vi.hoisted(() => vi.fn());
const mockGetClientByNode = vi.hoisted(() => vi.fn());

vi.mock('../models/index', () => ({
  AppDataSource: {
    getRepository: () => mockRepo,
  },
}));
vi.mock('../models/Card', () => ({
  Card: { findOneBy: vi.fn().mockResolvedValue(null), find: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../sessions/worktree', () => ({
  ensureWorktree: mockEnsureWorktree,
}));
vi.mock('../init-state', () => ({
  getOrcdClient: mockGetOrcdClient,
  getClientByNode: mockGetClientByNode,
}));

// We test the routing concept: orcd messages for a tracked session
// should be published to the correct card's bus topics.

describe('orcd message router', () => {
  let bus: MessageBus;
  let handler: ((msg: unknown) => void | Promise<void>) | null;

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
      promptsSent: 1,
      contextTokens: 0,
      contextWindow: 200000,
      turnsCompleted: 0,
      provider: 'anthropic',
      model: 'sonnet',
      nodeName: 'local',
      summarizeThreshold: 0.6,
      updatedAt: '',
      save: vi.fn(),
    });
    mockRepo.findOneBy.mockClear();
    mockRepo.find.mockClear();
    mockRepo.save.mockClear();
    mockEnsureWorktree.mockReset();
    mockEnsureWorktree.mockResolvedValue('/tmp/project/.worktrees/card-42');
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

  it('routes session_exit by DB session_id when in-memory mapping is missing and moves prompted running cards to review', async () => {
    const { initOrcdRouter } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);

    const exitSpy = vi.fn();
    bus.on('card:42:exit', exitSpy);

    await handler!({
      type: 'session_exit',
      sessionId: 'sess-abc',
      state: 'completed',
    });

    expect(mockCards[0].column).toBe('review');
    expect(mockRepo.save).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith({
      sessionId: 'sess-abc',
      status: 'completed',
    });
  });

  it('preserves errored session_exit status', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    const exitSpy = vi.fn();
    bus.on('card:42:exit', exitSpy);

    await handler!({
      type: 'session_exit',
      sessionId: 'sess-abc',
      state: 'errored',
    });

    expect(mockCards[0].column).toBe('running');
    expect(exitSpy).toHaveBeenCalledWith({
      sessionId: 'sess-abc',
      status: 'errored',
    });
  });

  it('moves running cards to review on turn_complete without untracking the live session', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    const sdkSpy = vi.fn();
    bus.on('card:42:sdk', sdkSpy);
    mockCards[0].column = 'running';
    mockRepo.save.mockClear();

    await handler!({
      type: 'turn_complete',
      sessionId: 'sess-abc',
      eventIndex: 9,
      hasPendingAsyncTasks: true,
    });

    expect(mockCards[0].column).toBe('review');
    expect(mockRepo.save).toHaveBeenCalledWith(mockCards[0]);
    expect(sdkSpy).toHaveBeenCalledWith({
      type: 'turn_complete',
      session_id: 'sess-abc',
      has_pending_async_tasks: true,
    });

    sdkSpy.mockClear();
    await handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 10,
      event: { type: 'assistant', message: 'still routed after turn complete' },
    });

    expect(sdkSpy).toHaveBeenCalledWith({ type: 'assistant', message: 'still routed after turn complete' });
  });

  it('surfaces non-archive cards in review on session_exit after a pending-background turn completed', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    mockCards[0].column = 'running';
    mockRepo.save.mockClear();

    await handler!({
      type: 'turn_complete',
      sessionId: 'sess-abc',
      eventIndex: 3,
      hasPendingAsyncTasks: true,
    });
    expect(mockCards[0].column).toBe('review');

    mockCards[0].column = 'done';
    mockRepo.save.mockClear();

    await handler!({
      type: 'session_exit',
      sessionId: 'sess-abc',
      state: 'completed',
    });

    expect(mockCards[0].column).toBe('review');
    expect(mockRepo.save).toHaveBeenCalledWith(mockCards[0]);
  });

  it('leaves archived cards archived when pending-background sessions exit', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    mockCards[0].column = 'running';
    mockRepo.save.mockClear();

    await handler!({
      type: 'turn_complete',
      sessionId: 'sess-abc',
      eventIndex: 3,
      hasPendingAsyncTasks: true,
    });

    mockCards[0].column = 'archive';
    mockRepo.save.mockClear();

    await handler!({
      type: 'session_exit',
      sessionId: 'sess-abc',
      state: 'completed',
    });

    expect(mockCards[0].column).toBe('archive');
    expect(mockRepo.save).not.toHaveBeenCalled();
  });

  it('does not move non-running cards to ready on ordinary foreground session_exit', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');

    mockCards[0].column = 'running';
    mockRepo.save.mockClear();

    await handler!({
      type: 'turn_complete',
      sessionId: 'sess-abc',
      eventIndex: 3,
      hasPendingAsyncTasks: false,
    });

    expect(mockCards[0].column).toBe('review');
    mockRepo.save.mockClear();

    await handler!({
      type: 'session_exit',
      sessionId: 'sess-abc',
      state: 'completed',
    });

    expect(mockCards[0].column).toBe('review');
    expect(mockRepo.save).not.toHaveBeenCalled();
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

  it('routes late compact_boundary after session_exit via bgcMap only', async () => {
    const { initOrcdRouter, trackSession } = await import('./card-sessions');
    initOrcdRouter(mockClient as never, bus);
    trackSession(42, 'sess-abc');
    mockCards[0].contextTokens = 50000;

    await handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 0,
      event: { type: 'system', subtype: 'bgc_started', session_id: 'sess-abc' },
    });

    await handler!({
      type: 'session_exit',
      sessionId: 'sess-abc',
      state: 'completed',
    });

    const sdkSpy = vi.fn();
    bus.on('card:42:sdk', sdkSpy);

    await handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 1,
      event: { type: 'system', subtype: 'compact_boundary', session_id: 'sess-abc' },
    });

    expect(mockCards[0].contextTokens).toBe(1);
    expect(mockRepo.save).toHaveBeenCalled();
    expect(sdkSpy).toHaveBeenCalledWith({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'sess-abc',
    });

    sdkSpy.mockClear();
    await handler!({
      type: 'stream_event',
      sessionId: 'sess-abc',
      eventIndex: 2,
      event: { type: 'assistant', message: 'late hello' },
    });

    expect(sdkSpy).not.toHaveBeenCalled();
  });
});

describe('reconcileRunningCards', () => {
  beforeEach(() => {
    mockEnsureWorktree.mockReset();
    mockEnsureWorktree.mockResolvedValue('/tmp/project/.worktrees/card-42');
  });

  it('moves prompted running cards to review when orcd only lists stopped session', async () => {
    const { reconcileRunningCards } = await import('./card-sessions');
    const bus = new MessageBus();
    const exitSpy = vi.fn();
    bus.on('card:42:exit', exitSpy);
    mockCards[0].column = 'running';
    mockCards[0].sessionId = 'sess-abc';
    mockCards[0].promptsSent = 1;
    mockRepo.save.mockClear();
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
    expect(mockRepo.save).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith({
      sessionId: 'sess-abc',
      status: 'stopped',
    });
  });

  it('moves auto-started running cards with an existing stopped session to review', async () => {
    const { reconcileRunningCards } = await import('./card-sessions');
    const bus = new MessageBus();
    const exitSpy = vi.fn();
    bus.on('card:42:exit', exitSpy);
    mockCards[0].column = 'running';
    mockCards[0].promptsSent = 0;
    mockRepo.save.mockClear();
    const client = {
      list: vi.fn(async () => ({
        type: 'session_list',
        sessions: [{ id: 'sess-abc', state: 'stopped', cwd: '/tmp' }],
      })),
      markActive: vi.fn(),
    };

    await reconcileRunningCards(client as never, bus);

    expect(mockCards[0].column).toBe('review');
    expect(mockRepo.save).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith({
      sessionId: 'sess-abc',
      status: 'stopped',
    });
  });

  it('starts running cards with no sessionId during reconciliation', async () => {
    const { reconcileRunningCards } = await import('./card-sessions');
    const bus = new MessageBus();
    const exitSpy = vi.fn();
    bus.on('card:42:exit', exitSpy);
    mockCards[0].column = 'running';
    mockCards[0].sessionId = null;
    mockCards[0].promptsSent = 0;
    mockRepo.save.mockClear();
    const client = {
      list: vi.fn(async () => ({
        type: 'session_list',
        sessions: [],
      })),
      markActive: vi.fn(),
      create: vi.fn(async () => 'sess-new'),
    };

    await reconcileRunningCards(client as never, bus);

    expect(mockCards[0].column).toBe('running');
    expect(mockCards[0].sessionId).toBe('sess-new');
    expect(client.create).toHaveBeenCalledWith({
      prompt: '',
      cwd: '/tmp/project/.worktrees/card-42',
      provider: 'anthropic',
      model: 'sonnet',
      sessionId: undefined,
      contextWindow: 200000,
      summarizeThreshold: 0.6,
    });
    expect(mockRepo.save).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('moves cards to review when auto-start setup fails during reconciliation', async () => {
    const { reconcileRunningCards } = await import('./card-sessions');
    const bus = new MessageBus();
    const exitSpy = vi.fn();
    bus.on('card:42:exit', exitSpy);
    mockCards[0].column = 'running';
    mockCards[0].sessionId = null;
    mockEnsureWorktree.mockRejectedValue(new Error('bun: command not found'));
    const client = {
      list: vi.fn(async () => ({
        type: 'session_list',
        sessions: [],
      })),
      markActive: vi.fn(),
      create: vi.fn(async () => 'sess-new'),
    };

    await reconcileRunningCards(client as never, bus);

    expect(mockCards[0].column).toBe('review');
    expect(mockCards[0].sessionId).toBeNull();
    expect(client.create).not.toHaveBeenCalled();
    expect(mockRepo.save).toHaveBeenCalledWith(mockCards[0]);
    expect(exitSpy).toHaveBeenCalledWith({
      sessionId: null,
      status: 'errored',
    });
  });

  it('routes early session events before the new sessionId save finishes', async () => {
    vi.resetModules();
    const { initOrcdRouter, reconcileRunningCards } = await import('./card-sessions');
    const bus = new MessageBus();
    let earlyHandler: ((msg: unknown) => void | Promise<void>) | null = null;
    const sdkSpy = vi.fn();
    bus.on('card:42:sdk', sdkSpy);

    mockCards[0].column = 'running';
    mockCards[0].sessionId = null;
    mockRepo.save.mockClear();

    const client = {
      onMessage: vi.fn((h: (msg: unknown) => void | Promise<void>) => { earlyHandler = h; }),
      offMessage: vi.fn(),
      list: vi.fn(async () => ({
        type: 'session_list',
        sessions: [],
      })),
      markActive: vi.fn(),
      create: vi.fn(async () => 'sess-new'),
    };

    initOrcdRouter(client as never, bus);
    mockRepo.save.mockImplementationOnce(async (card: MockCard) => {
      await earlyHandler!({
        type: 'stream_event',
        sessionId: 'sess-new',
        eventIndex: 0,
        event: { type: 'assistant', message: 'early output' },
      });
      return card;
    });

    await reconcileRunningCards(client as never, bus);

    expect(sdkSpy).toHaveBeenCalledWith({ type: 'assistant', message: 'early output' });
    expect(mockCards[0].sessionId).toBe('sess-new');
  });
});

describe('registerAutoStart', () => {
  const mockCancel = vi.fn();
  const mockIsActive = vi.fn();
  const mockCreate = vi.fn();

  beforeEach(() => {
    mockCancel.mockReset();
    mockIsActive.mockReset();
    mockCreate.mockReset();
    mockCreate.mockResolvedValue('sess-new');
    mockEnsureWorktree.mockReset();
    mockEnsureWorktree.mockResolvedValue('/tmp/project/.worktrees/card-42');
    mockRepo.save.mockClear();
    const fakeClient = {
      cancel: mockCancel,
      isActive: mockIsActive,
      create: mockCreate,
      isConnected: () => true,
    };
    mockGetOrcdClient.mockReset();
    mockGetOrcdClient.mockReturnValue(fakeClient);
    mockGetClientByNode.mockReset();
    mockGetClientByNode.mockReturnValue(fakeClient);
    mockCards.splice(0, mockCards.length, {
      id: 42,
      sessionId: 'sess-abc',
      column: 'running',
      promptsSent: 1,
      contextTokens: 0,
      contextWindow: 200000,
      turnsCompleted: 0,
      provider: 'anthropic',
      model: 'sonnet',
      nodeName: 'local',
      summarizeThreshold: 0.6,
      updatedAt: '',
      save: vi.fn(),
    });
  });

  it('does not cancel a live session when a card leaves running', async () => {
    const { registerAutoStart } = await import('./card-sessions');
    const bus = new MessageBus();
    registerAutoStart(bus);

    bus.publish('board:changed', {
      card: mockCards[0],
      oldColumn: 'running',
      newColumn: 'review',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('does not start a duplicate session when a card enters running with a live session', async () => {
    const { registerAutoStart } = await import('./card-sessions');
    const bus = new MessageBus();
    registerAutoStart(bus);
    mockIsActive.mockReturnValue(true);

    bus.publish('board:changed', {
      card: mockCards[0],
      oldColumn: 'review',
      newColumn: 'running',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('starts a session when a card enters running without a live session', async () => {
    const { registerAutoStart } = await import('./card-sessions');
    const bus = new MessageBus();
    registerAutoStart(bus);
    mockCards[0].sessionId = null;
    mockIsActive.mockReturnValue(false);

    bus.publish('board:changed', {
      card: mockCards[0],
      oldColumn: 'backlog',
      newColumn: 'running',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mockCreate).toHaveBeenCalled();
    expect(mockCards[0].sessionId).toBe('sess-new');
  });
});
