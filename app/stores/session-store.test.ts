import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from './session-store';
import type { SdkMessage } from '../lib/sdk-types';
import type { WsClient } from '../lib/ws-client';

vi.mock('../lib/conversation-cache', () => ({
  readConversation: vi.fn(),
  writeConversation: vi.fn(() => Promise.resolve()),
}));

import { readConversation, writeConversation } from '../lib/conversation-cache';

function startBlockingSubagent(store: SessionStore, cardId: number): void {
  store.ingestSdkMessage(cardId, {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_agent', name: 'Agent' },
    },
  } as SdkMessage);
  store.ingestSdkMessage(cardId, {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"description":"Review subagent UI fix"}' },
    },
  } as SdkMessage);
  store.ingestSdkMessage(cardId, {
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
  } as SdkMessage);
}

describe('SessionStore subagent lifecycle', () => {
  it('does not emit second compact request while background compaction is in progress', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);

    await store.compactSession(1011);
    store.ingestSdkMessage(1011, {
      type: 'system',
      subtype: 'bgc_started',
      timestamp: Date.now(),
    } as SdkMessage);
    await store.compactSession(1011);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('agent:compact', { cardId: 1011 });
    expect(store.getSession(1011)?.accumulator.conversation.at(-1)).toMatchObject({
      kind: 'compact',
      label: 'Background compaction already in progress',
    });
  });

  it('shows blocked compact notice with timestamp when background compaction is already in progress', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);

    store.ingestSdkMessage(1011, {
      type: 'system',
      subtype: 'bgc_started',
      timestamp: Date.now(),
    } as SdkMessage);
    await store.compactSession(1011);

    const last = store.getSession(1011)?.accumulator.conversation.at(-1);
    expect(last?.kind).toBe('compact');
    if (last?.kind === 'compact') {
      expect(last.label).toBe('Background compaction already in progress');
      expect(typeof last.timestamp).toBe('number');
    }
  });

  it('allows compact again after background compaction is applied', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);

    store.ingestSdkMessage(1011, {
      type: 'system',
      subtype: 'bgc_started',
      timestamp: Date.now(),
    } as SdkMessage);
    store.ingestSdkMessage(1011, {
      type: 'system',
      subtype: 'compact_boundary',
      source: 'orchestrel-bgc',
      timestamp: Date.now(),
    } as SdkMessage);
    await store.compactSession(1011);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('agent:compact', { cardId: 1011 });
  });

  it('sets context tokens to sentinel 1 when background compaction is applied', () => {
    const store = new SessionStore();

    store.handleAgentStatus({
      cardId: 1011,
      active: true,
      status: 'running',
      sessionId: 'sess-abc',
      promptsSent: 1,
      turnsCompleted: 1,
      contextTokens: 50000,
      contextWindow: 200000,
    });
    store.ingestSdkMessage(1011, {
      type: 'system',
      subtype: 'compact_boundary',
      source: 'orchestrel-bgc',
      timestamp: Date.now(),
    } as SdkMessage);

    expect(store.getSession(1011)?.contextTokens).toBe(1);
  });

  it('accepts zero context token updates from agent status', () => {
    const store = new SessionStore();

    store.handleAgentStatus({
      cardId: 1011,
      active: true,
      status: 'running',
      sessionId: 'sess-abc',
      promptsSent: 1,
      turnsCompleted: 1,
      contextTokens: 50000,
      contextWindow: 200000,
    });
    store.handleAgentStatus({
      cardId: 1011,
      active: false,
      status: 'completed',
      sessionId: 'sess-abc',
      promptsSent: 1,
      turnsCompleted: 1,
      contextTokens: 0,
      contextWindow: 200000,
    });

    expect(store.getSession(1011)?.contextTokens).toBe(0);
  });

  it('clears subagents when agent status is terminal', () => {
    const store = new SessionStore();
    startBlockingSubagent(store, 1011);

    store.handleAgentStatus({
      cardId: 1011,
      active: false,
      status: 'completed',
      sessionId: 'sess-abc',
      promptsSent: 1,
      turnsCompleted: 1,
      contextTokens: 0,
      contextWindow: 200000,
    });

    expect(store.getSession(1011)?.accumulator.subagents.size).toBe(0);
  });

  it('reloads history once when a subscribed session transitions active→terminal', async () => {
    // Pi flushes the final assistant message to the session file only as the run
    // resolves (≈ session_exit), so a load during the finishing window misses it.
    // The store must reload on the active→terminal edge to backfill that message.
    const emit = vi.fn().mockResolvedValue({ messages: [] });
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);

    await store.loadHistory(1011, 'sess-abc'); // subscribes the card
    store.handleAgentStatus({
      cardId: 1011,
      active: true,
      status: 'running',
      sessionId: 'sess-abc',
      promptsSent: 1,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
    });

    emit.mockClear();
    store.handleAgentStatus({
      cardId: 1011,
      active: false,
      status: 'completed',
      sessionId: 'sess-abc',
      promptsSent: 1,
      turnsCompleted: 1,
      contextTokens: 0,
      contextWindow: 200000,
    });

    expect(emit).toHaveBeenCalledWith('session:load', { cardId: 1011, sessionId: 'sess-abc' });
  });

  it('does not reload history for an unsubscribed card on terminal status', () => {
    const emit = vi.fn().mockResolvedValue({ messages: [] });
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);

    store.handleAgentStatus({
      cardId: 1011,
      active: true,
      status: 'running',
      sessionId: 'sess-abc',
      promptsSent: 1,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
    });
    store.handleAgentStatus({
      cardId: 1011,
      active: false,
      status: 'completed',
      sessionId: 'sess-abc',
      promptsSent: 1,
      turnsCompleted: 1,
      contextTokens: 0,
      contextWindow: 200000,
    });

    expect(emit).not.toHaveBeenCalledWith('session:load', expect.anything());
  });

  it('clears subagents when session exits', () => {
    const store = new SessionStore();
    startBlockingSubagent(store, 1011);

    store.handleSessionExit(1011);

    expect(store.getSession(1011)?.accumulator.subagents.size).toBe(0);
  });

  it('marks the session errored immediately when an SDK error arrives', () => {
    const store = new SessionStore();

    store.handleAgentStatus({
      cardId: 1011,
      active: true,
      status: 'running',
      sessionId: 'sess-abc',
      promptsSent: 1,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
    });

    store.ingestSdkMessage(1011, {
      type: 'error',
      message: 'Provider request failed',
      timestamp: Date.now(),
    } as SdkMessage);

    expect(store.getSession(1011)).toMatchObject({
      active: false,
      status: 'errored',
      bgcInProgress: false,
    });
  });
});

describe('SessionStore hydrateFromCache', () => {
  it('paints cached conversation when history not yet loaded', async () => {
    vi.mocked(readConversation).mockResolvedValue([{ kind: 'user', content: 'cached' }]);
    const store = new SessionStore();

    await store.hydrateFromCache(1);

    const s = store.getSession(1);
    expect(s?.cacheHydrated).toBe(true);
    expect(s?.accumulator.conversation).toEqual([
      expect.objectContaining({ kind: 'user', content: 'cached' }),
    ]);
  });

  it('does not clobber already-loaded history', async () => {
    vi.mocked(readConversation).mockResolvedValue([{ kind: 'user', content: 'cached' }]);
    const store = new SessionStore();
    store.ingestHistory(1, []); // sets historyLoaded = true
    store.getSession(1)!.accumulator.addUserMessage('live');

    await store.hydrateFromCache(1);

    expect(store.getSession(1)?.accumulator.conversation).toEqual([
      expect.objectContaining({ kind: 'user', content: 'live' }),
    ]);
  });
});

describe('SessionStore evictSession', () => {
  it('drops an inactive session from memory and flushes it to the cache', async () => {
    vi.mocked(writeConversation).mockClear();
    const store = new SessionStore();
    store.ingestHistory(7, []);
    store.getSession(7)!.accumulator.addUserMessage('keep me');

    await store.evictSession(7);

    // RAM copy is gone, but the transcript was written to IndexedDB on the way out.
    expect(store.getSession(7)).toBeUndefined();
    expect(writeConversation).toHaveBeenCalledWith(7, [
      expect.objectContaining({ kind: 'user', content: 'keep me' }),
    ]);
  });

  it('never evicts an active (running) session', async () => {
    const store = new SessionStore();
    store.ingestSdkMessage(9, { type: 'assistant' } as SdkMessage); // flips session active
    expect(store.getSession(9)?.active).toBe(true);

    await store.evictSession(9);

    expect(store.getSession(9)?.active).toBe(true);
  });
});
