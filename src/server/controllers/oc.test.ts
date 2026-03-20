import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { DataSource } from 'typeorm';
import { Card, CardSubscriber } from '../models/Card';
import { Project, ProjectSubscriber } from '../models/Project';
import { MessageBus } from '../bus';
import type { AgentMessage } from '../agents/types';

let ds: DataSource;

beforeAll(async () => {
  ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Card, Project],
    subscribers: [CardSubscriber, ProjectSubscriber],
    synchronize: true,
  });
  await ds.initialize();
});

afterAll(async () => {
  await ds.destroy();
});

function fakeSession() {
  const session = new EventEmitter() as EventEmitter & {
    promptsSent: number;
    turnsCompleted: number;
    sessionId: string | null;
    status: string;
  };
  session.promptsSent = 1;
  session.turnsCompleted = 1;
  session.sessionId = 'test-session-123';
  session.status = 'running';
  return session;
}

describe('OC controller: wireSession', () => {
  it('publishes displayable messages to the domain bus', async () => {
    const bus = new MessageBus();
    const handler = vi.fn();
    const session = fakeSession();

    const { wireSession } = await import('./oc');
    const card = Card.create({
      title: 'Test',
      description: 'Test',
      column: 'running',
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    wireSession(card.id, session as never, bus);
    bus.subscribe(`card:${card.id}:message`, handler);

    session.emit('message', {
      type: 'text',
      role: 'assistant',
      content: 'hello',
      timestamp: Date.now(),
    } satisfies AgentMessage);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ type: 'text', content: 'hello' });
  });

  it('does NOT publish non-display message types to bus', async () => {
    const bus = new MessageBus();
    const handler = vi.fn();
    const session = fakeSession();

    const { wireSession } = await import('./oc');
    const card = Card.create({
      title: 'Test2',
      description: 'Test',
      column: 'running',
      position: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    wireSession(card.id, session as never, bus);
    bus.subscribe(`card:${card.id}:message`, handler);

    session.emit('message', {
      type: 'internal' as never,
      role: 'system',
      content: '',
      timestamp: Date.now(),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('moves card to review and persists counters on turn_end', async () => {
    const bus = new MessageBus();
    const session = fakeSession();
    session.promptsSent = 3;
    session.turnsCompleted = 2;

    const { wireSession } = await import('./oc');
    const card = Card.create({
      title: 'Turn test',
      description: 'Test',
      column: 'running',
      position: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    wireSession(card.id, session as never, bus);

    session.emit('message', {
      type: 'turn_end',
      role: 'system',
      content: '',
      timestamp: Date.now(),
    } satisfies AgentMessage);

    await new Promise((r) => setTimeout(r, 50));
    await card.reload();
    expect(card.column).toBe('review');
    expect(card.promptsSent).toBe(3);
    expect(card.turnsCompleted).toBe(2);
  });

  it('moves card to review on exit with errored status', async () => {
    const bus = new MessageBus();
    const session = fakeSession();
    session.status = 'errored';

    const { wireSession } = await import('./oc');
    const card = Card.create({
      title: 'Exit test',
      description: 'Test',
      column: 'running',
      position: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    wireSession(card.id, session as never, bus);
    session.emit('exit');

    await new Promise((r) => setTimeout(r, 50));
    await card.reload();
    expect(card.column).toBe('review');
  });

  it('does NOT move card on exit with completed status', async () => {
    const bus = new MessageBus();
    const session = fakeSession();
    session.status = 'completed';

    const { wireSession } = await import('./oc');
    const card = Card.create({
      title: 'Completed exit',
      description: 'Test',
      column: 'running',
      position: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    wireSession(card.id, session as never, bus);
    session.emit('exit');

    await new Promise((r) => setTimeout(r, 50));
    await card.reload();
    expect(card.column).toBe('running');
  });

  it('publishes exit status to bus', async () => {
    const bus = new MessageBus();
    const handler = vi.fn();
    const session = fakeSession();
    session.status = 'stopped';

    const { wireSession } = await import('./oc');
    const card = Card.create({
      title: 'Exit bus test',
      description: 'Test',
      column: 'running',
      position: 6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    wireSession(card.id, session as never, bus);
    bus.subscribe(`card:${card.id}:exit`, handler);
    session.emit('exit');

    await new Promise((r) => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ cardId: card.id, status: 'stopped' });
  });
});

describe('OC controller: registerAutoStart', () => {
  it('calls startSession when card enters running', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerAutoStart } = await import('./oc');
    registerAutoStart(bus, { startSession: startMock, attachSession: vi.fn().mockResolvedValue(false) });

    const card = Card.create({
      title: 'Auto test',
      description: 'Test',
      column: 'running',
      position: 20,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    bus.publish('board:changed', { card, oldColumn: 'ready', newColumn: 'running' });

    await new Promise((r) => setTimeout(r, 50));
    expect(startMock).toHaveBeenCalledWith(card.id, undefined);
  });

  it('does NOT call startSession for other column transitions', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerAutoStart } = await import('./oc');
    registerAutoStart(bus, { startSession: startMock, attachSession: vi.fn().mockResolvedValue(false) });

    const card = Card.create({
      title: 'No start',
      description: 'Test',
      column: 'review',
      position: 21,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    bus.publish('board:changed', { card, oldColumn: 'running', newColumn: 'review' });

    await new Promise((r) => setTimeout(r, 50));
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe('OC controller: registerAutoStart queue assignment', () => {
  it('queues non-worktree card when conflict group has active card', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerAutoStart } = await import('./oc');
    registerAutoStart(bus, { startSession: startMock, attachSession: vi.fn().mockResolvedValue(false) });

    const proj = Project.create({
      name: 'Queue proj',
      path: '/tmp/q',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    const active = Card.create({
      title: 'Active',
      description: 'Test',
      column: 'running',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await active.save();

    // Register a fake session so processQueue sees the active card as running
    const { sessionManager } = await import('../agents/manager');
    const fakeActiveSession = fakeSession();
    fakeActiveSession.status = 'running';
    vi.spyOn(sessionManager, 'get').mockImplementation((cardId: number) =>
      cardId === active.id ? (fakeActiveSession as never) : undefined,
    );

    const queued = Card.create({
      title: 'Queued',
      description: 'Test',
      column: 'running',
      position: 1,
      projectId: proj.id,
      useWorktree: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await queued.save();

    bus.publish('board:changed', { card: queued, oldColumn: 'ready', newColumn: 'running' });
    await new Promise((r) => setTimeout(r, 50));

    await queued.reload();
    expect(queued.queuePosition).toBe(1);
    expect(startMock).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('does not queue non-worktree card when no conflict exists', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerAutoStart } = await import('./oc');
    registerAutoStart(bus, { startSession: startMock, attachSession: vi.fn().mockResolvedValue(false) });

    // Mock sessionService.launchSession so processQueue can call it
    const { sessionService } = await import('../services/session');
    const sessionStartMock = vi.spyOn(sessionService, 'launchSession').mockResolvedValue(undefined);

    const proj = Project.create({
      name: 'Solo proj',
      path: '/tmp/s',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    const card = Card.create({
      title: 'Solo',
      description: 'Test',
      column: 'running',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    bus.publish('board:changed', { card, oldColumn: 'ready', newColumn: 'running' });
    await new Promise((r) => setTimeout(r, 50));

    await card.reload();
    expect(card.queuePosition).toBeNull();
    // processQueue calls sessionService.launchSession, not the mock starter
    expect(sessionStartMock).toHaveBeenCalledWith(card.id);
    sessionStartMock.mockRestore();
  });

  it('does not queue worktree cards even when conflict group exists', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerAutoStart } = await import('./oc');
    registerAutoStart(bus, { startSession: startMock, attachSession: vi.fn().mockResolvedValue(false) });

    const proj = Project.create({
      name: 'WT proj',
      path: '/tmp/wt',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    const active = Card.create({
      title: 'Active NW',
      description: 'Test',
      column: 'running',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await active.save();

    const wtCard = Card.create({
      title: 'WT card',
      description: 'Test',
      column: 'running',
      position: 1,
      projectId: proj.id,
      useWorktree: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await wtCard.save();

    bus.publish('board:changed', { card: wtCard, oldColumn: 'ready', newColumn: 'running' });
    await new Promise((r) => setTimeout(r, 50));

    expect(startMock).toHaveBeenCalledWith(wtCard.id, undefined);
  });

  it('does not start queued cards when active session exists', async () => {
    const bus = new MessageBus();
    const startMock = vi.fn().mockResolvedValue(undefined);
    const { registerAutoStart } = await import('./oc');
    registerAutoStart(bus, { startSession: startMock, attachSession: vi.fn().mockResolvedValue(false) });

    // Mock sessionManager to report an active session on the active card
    const { sessionManager } = await import('../agents/manager');
    const getMock = vi.spyOn(sessionManager, 'get');

    const proj = Project.create({
      name: 'Queued proj',
      path: '/tmp/qp',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    const active = Card.create({
      title: 'Active card',
      description: 'Test',
      column: 'running',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await active.save();

    const queued = Card.create({
      title: 'Queued card',
      description: 'Test',
      column: 'running',
      position: 1,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await queued.save();

    getMock.mockImplementation((cardId: number) => {
      if (cardId === active.id) return { status: 'running' } as ReturnType<typeof sessionManager.get>;
      return undefined;
    });

    bus.publish('board:changed', { card: queued, oldColumn: 'ready', newColumn: 'running' });
    await new Promise((r) => setTimeout(r, 50));

    // processQueue sees active session, doesn't start anything new
    expect(startMock).not.toHaveBeenCalled();
    getMock.mockRestore();
  });
});

describe('processQueue: queue processing on column exit', () => {
  it('promotes next card and renumbers when active card leaves running', async () => {
    // Mock sessionService.launchSession so processQueue can call it
    const { sessionService } = await import('../services/session');
    const sessionStartMock = vi.spyOn(sessionService, 'launchSession').mockResolvedValue(undefined);

    const proj = Project.create({
      name: 'Promo proj',
      path: '/tmp/promo',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    const active = Card.create({
      title: 'Active',
      description: 'Test',
      column: 'running',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await active.save();

    const next = Card.create({
      title: 'Next',
      description: 'Test',
      column: 'running',
      position: 1,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await next.save();

    const third = Card.create({
      title: 'Third',
      description: 'Test',
      column: 'running',
      position: 2,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await third.save();

    // Active card leaves running — call processQueue directly
    active.column = 'review';
    active.updatedAt = new Date().toISOString();
    await active.save();

    const { processQueue } = await import('../services/queue-gate');
    await processQueue(proj.id);

    await next.reload();
    await third.reload();
    expect(active.queuePosition).toBeNull();
    expect(next.queuePosition).toBeNull(); // promoted
    expect(third.queuePosition).toBe(1); // decremented from 2
    expect(sessionStartMock).toHaveBeenCalledWith(next.id);
    sessionStartMock.mockRestore();
  });

  it('renumbers queue when a queued card leaves running', async () => {
    // Mock sessionManager to report active session on the active card
    const { sessionManager } = await import('../agents/manager');
    const getMock = vi.spyOn(sessionManager, 'get');

    const proj = Project.create({
      name: 'Renum proj',
      path: '/tmp/renum',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    const active = Card.create({
      title: 'Active',
      description: 'Test',
      column: 'running',
      position: 0,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await active.save();

    const removed = Card.create({
      title: 'Removed',
      description: 'Test',
      column: 'running',
      position: 1,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await removed.save();

    const remaining = Card.create({
      title: 'Remaining',
      description: 'Test',
      column: 'running',
      position: 2,
      projectId: proj.id,
      useWorktree: false,
      queuePosition: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await remaining.save();

    // Mock active card as having a running session
    getMock.mockImplementation((cardId: number) => {
      if (cardId === active.id) return { status: 'running' } as ReturnType<typeof sessionManager.get>;
      return undefined;
    });

    // Queued card leaves running — call processQueue directly to renumber
    removed.column = 'ready';
    removed.updatedAt = new Date().toISOString();
    await removed.save();

    const { processQueue } = await import('../services/queue-gate');
    await processQueue(proj.id);

    await remaining.reload();
    await removed.reload();
    expect(remaining.queuePosition).toBe(1); // decremented from 2
    expect(removed.queuePosition).toBeNull(); // cleared by beforeUpdate hook
    getMock.mockRestore();
  });

  it('clears queuePosition when card moves to any non-running column', async () => {
    const card = Card.create({
      title: 'Clearing',
      description: 'Test',
      column: 'running',
      position: 0,
      queuePosition: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    card.column = 'done';
    card.updatedAt = new Date().toISOString();
    await card.save();

    await card.reload();
    expect(card.queuePosition).toBeNull();
  });
});

describe('OC controller: registerWorktreeCleanup', () => {
  it('removes worktree when card with worktree moves to archive', async () => {
    const bus = new MessageBus();
    const removeMock = vi.fn();
    const existsMock = vi.fn().mockReturnValue(true);
    const { registerWorktreeCleanup } = await import('./oc');
    registerWorktreeCleanup(bus, { removeWorktree: removeMock, worktreeExists: existsMock });

    const proj = Project.create({
      name: 'WT Project',
      path: '/tmp/wt-proj',
      createdAt: new Date().toISOString(),
    } as Partial<Project> as Project);
    await proj.save();

    const card = Card.create({
      title: 'WT card',
      description: 'Test',
      column: 'archive',
      position: 30,
      projectId: proj.id,
      useWorktree: true,
      worktreePath: '/tmp/wt-proj/.worktrees/slug',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    bus.publish('board:changed', { card, oldColumn: 'done', newColumn: 'archive' });

    await new Promise((r) => setTimeout(r, 50));
    expect(removeMock).toHaveBeenCalledWith('/tmp/wt-proj', '/tmp/wt-proj/.worktrees/slug');
  });

  it('does NOT remove worktree when useWorktree is false', async () => {
    const bus = new MessageBus();
    const removeMock = vi.fn();
    const existsMock = vi.fn().mockReturnValue(true);
    const { registerWorktreeCleanup } = await import('./oc');
    registerWorktreeCleanup(bus, { removeWorktree: removeMock, worktreeExists: existsMock });

    const card = Card.create({
      title: 'No WT',
      description: 'Test',
      column: 'archive',
      position: 31,
      useWorktree: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await card.save();

    bus.publish('board:changed', { card, oldColumn: 'done', newColumn: 'archive' });

    await new Promise((r) => setTimeout(r, 50));
    expect(removeMock).not.toHaveBeenCalled();
  });
});
