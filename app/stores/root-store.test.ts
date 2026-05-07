// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { AckResponse, ClientToServerEvents, Column, ServerToClientEvents, SyncPayload } from '../../src/shared/ws-protocol';

class FakeSocket {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  ioHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  connected = true;
  nextSubscribeData: SyncPayload | undefined;

  on(event: keyof ServerToClientEvents | 'connect' | 'disconnect' | 'connect_error', handler: (...args: unknown[]) => void) {
    const key = String(event);
    const list = this.handlers.get(key) ?? [];
    list.push(handler);
    this.handlers.set(key, list);
    return this;
  }

  io = {
    on: (event: 'reconnect', handler: (...args: unknown[]) => void) => {
      const list = this.ioHandlers.get(event) ?? [];
      list.push(handler);
      this.ioHandlers.set(event, list);
      return this.io;
    },
  };

  emitWithAck(event: keyof ClientToServerEvents, _data: unknown): Promise<AckResponse> {
    if (event === 'subscribe') {
      return Promise.resolve({ data: this.nextSubscribeData });
    }
    if (event === 'agent:status') {
      return Promise.resolve({});
    }
    if (event === 'session:load') {
      return Promise.resolve({ data: { messages: [] } });
    }
    return Promise.resolve({});
  }

  disconnect() {
    this.connected = false;
    return this;
  }

  connect() {
    this.connected = true;
    this.trigger('connect');
    return this;
  }

  trigger(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  triggerIo(event: string, ...args: unknown[]) {
    for (const handler of this.ioHandlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

const fakeSocket = new FakeSocket();

vi.mock('socket.io-client', () => ({
  io: () => fakeSocket,
}));

function makeSyncPayload(column: Column): SyncPayload {
  return {
    cards: [
      {
        id: 42,
        title: 'Reconnect me',
        description: '',
        column,
        position: 0,
        projectId: 1,
        prUrl: null,
        sessionId: 'sess-42',
        worktreeBranch: null,
        sourceBranch: null,
        model: 'sonnet',
        provider: 'anthropic',
        thinkingLevel: 'high',
        summarizeThreshold: 0.7,
        promptsSent: 1,
        turnsCompleted: 0,
        contextTokens: 0,
        contextWindow: 200000,
        createdAt: '2026-05-07T00:00:00.000Z',
        updatedAt: '2026-05-07T00:00:00.000Z',
      },
    ],
    projects: [
      {
        id: 1,
        name: 'Project 1',
        path: '/tmp/project-1',
        setupCommands: '',
        isGitRepo: false,
        defaultBranch: null,
        defaultWorktree: false,
        defaultModel: 'sonnet',
        defaultThinkingLevel: 'high',
        providerID: 'anthropic',
        color: '#00f0ff',
        archived: false,
        memoryBaseUrl: null,
        memoryApiKey: null,
        createdAt: '2026-05-07T00:00:00.000Z',
      },
    ],
    providers: {},
    user: { id: 1, email: 'ryan@example.com', role: 'admin' },
    users: [],
  };
}

describe('RootStore websocket reconnect sync', () => {
  beforeEach(() => {
    fakeSocket.handlers.clear();
    fakeSocket.ioHandlers.clear();
    fakeSocket.connected = true;
    fakeSocket.nextSubscribeData = undefined;
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'denied';
        static requestPermission = vi.fn();
      },
    );
  });

  it('refreshes cards from subscribe sync payload after reconnect', async () => {
    const { RootStore } = await import('./root-store');
    const store = new RootStore();

    fakeSocket.nextSubscribeData = makeSyncPayload('running');
    store.subscribe(['running', 'review']);
    await waitFor(() => expect(store.cards.getCard(42)?.column).toBe('running'));

    fakeSocket.trigger('connect');

    fakeSocket.nextSubscribeData = makeSyncPayload('review');
    fakeSocket.trigger('connect');
    await waitFor(() => expect(store.cards.getCard(42)?.column).toBe('review'));
  });

  it('re-subscribes with the existing columns on reconnect', async () => {
    const { RootStore } = await import('./root-store');
    const store = new RootStore();
    const emitWithAck = vi.spyOn(fakeSocket, 'emitWithAck');

    fakeSocket.nextSubscribeData = makeSyncPayload('running');
    store.subscribe(['running', 'review']);
    await waitFor(() => expect(store.cards.getCard(42)?.column).toBe('running'));

    emitWithAck.mockClear();
    fakeSocket.nextSubscribeData = makeSyncPayload('review');
    fakeSocket.trigger('connect');
    fakeSocket.trigger('connect');

    await waitFor(() => expect(store.cards.getCard(42)?.column).toBe('review'));
    expect(emitWithAck).toHaveBeenCalledWith('subscribe', ['running', 'review']);
  });

  it('still reloads session subscriptions on reconnect', async () => {
    const { RootStore } = await import('./root-store');
    const store = new RootStore();
    const resubscribeAll = vi.spyOn(store.sessions, 'resubscribeAll').mockResolvedValue();

    fakeSocket.nextSubscribeData = makeSyncPayload('running');
    store.subscribe(['running']);
    await waitFor(() => expect(store.cards.getCard(42)?.column).toBe('running'));

    fakeSocket.trigger('connect');
    fakeSocket.nextSubscribeData = makeSyncPayload('review');
    fakeSocket.trigger('connect');

    await waitFor(() => expect(resubscribeAll).toHaveBeenCalled());
  });

  it('does nothing on reconnect before any board subscribe happened', async () => {
    const { RootStore } = await import('./root-store');
    const store = new RootStore();
    const emitWithAck = vi.spyOn(fakeSocket, 'emitWithAck');

    fakeSocket.trigger('connect');
    fakeSocket.trigger('connect');
    await Promise.resolve();

    expect(emitWithAck).not.toHaveBeenCalled();
    expect(store.cards.getCard(42)).toBeUndefined();
  });
});
