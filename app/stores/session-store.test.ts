import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from './session-store';
import type { HistoryMessage, SdkMessage } from '../lib/sdk-types';
import type { WsClient } from '../lib/ws-client';
import type { TranscriptHistoryPage } from '../../src/shared/transcript-history';

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

    expect(emit).toHaveBeenCalledWith('session:history-page', { cardId: 1011, page: {} });
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

describe('SessionStore evictSession', () => {
  it('drops an inactive session so it reloads from server history', () => {
    const store = new SessionStore();
    store.ingestHistory(7, []);
    store.getSession(7)!.accumulator.addUserMessage('server owns this');

    store.evictSession(7);

    expect(store.getSession(7)).toBeUndefined();
  });

  it('never evicts an active session because it still receives streamed messages', () => {
    const store = new SessionStore();
    store.ingestSdkMessage(9, { type: 'assistant' } as SdkMessage); // flips session active
    expect(store.getSession(9)?.active).toBe(true);

    store.evictSession(9);

    expect(store.getSession(9)?.active).toBe(true);
  });
});

describe('SessionStore sendMessage app slash commands', () => {
  it('echoes only what the model receives and marks the session running', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);

    await store.sendMessage(1, 'great! /merge /archive');

    const s = store.getSession(1)!;
    expect(s.accumulator.conversation.at(-1)).toMatchObject({ kind: 'user', content: 'great! /merge' });
    expect(s.status).toBe('running');
    expect(s.promptsSent).toBe(1);
    // The raw message goes to the server; it strips the command and moves the card.
    expect(emit).toHaveBeenCalledWith('agent:send', { cardId: 1, message: 'great! /merge /archive', files: undefined });
  });

  it('skips the transcript echo and running state for a command-only message', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);

    await store.sendMessage(2, '/archive');

    const s = store.getSession(2)!;
    expect(s.accumulator.conversation).toHaveLength(0);
    expect(s.active).toBe(false);
    expect(s.status).toBe('stopped');
    expect(s.promptsSent).toBe(0);
    expect(emit).toHaveBeenCalledWith('agent:send', { cardId: 2, message: '/archive', files: undefined });
  });

  it('skips the echo and running state for /delete even with surrounding text', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);

    await store.sendMessage(3, 'cleanup /delete');

    const s = store.getSession(3)!;
    expect(s.accumulator.conversation).toHaveLength(0);
    expect(s.active).toBe(false);
    expect(s.status).toBe('stopped');
    expect(s.promptsSent).toBe(0);
    // The raw message goes to the server; it strips the command and deletes the card.
    expect(emit).toHaveBeenCalledWith('agent:send', { cardId: 3, message: 'cleanup /delete', files: undefined });
  });
});

function userHistory(id: string, text: string): HistoryMessage {
  return {
    type: 'user',
    uuid: id,
    session_id: 'sess-1',
    parent_tool_use_id: null,
    timestamp: 1,
    message: { role: 'user', content: text },
  };
}

function historyPage(
  overrides: Partial<TranscriptHistoryPage> & Pick<TranscriptHistoryPage, 'records'>,
): TranscriptHistoryPage {
  return {
    sessionId: 'sess-1',
    revision: 'r1',
    before: null,
    after: null,
    prefix: 'p',
    hasOlder: false,
    hasNewer: false,
    reset: false,
    ...overrides,
  };
}

// Paging must grow the loaded window. A regression here replaces the visible
// transcript with the older page and loses the reader's place.
describe('SessionStore transcript paging', () => {
  it('prepends older pages so scrolling up accumulates history', async () => {
    const latest = historyPage({
      records: [
        { id: 'id3', message: userHistory('id3', 'three') },
        { id: 'id4', message: userHistory('id4', 'four') },
      ],
      before: 'id3',
      after: 'id4',
      hasOlder: true,
    });
    const older = historyPage({
      records: [
        { id: 'id1', message: userHistory('id1', 'one') },
        { id: 'id2', message: userHistory('id2', 'two') },
      ],
      before: 'id1',
      after: 'id2',
      hasNewer: true,
    });
    const emit = vi.fn(async (event: string, data: { page?: { before?: string } }) => {
      if (event !== 'session:history-page') return undefined;
      return data.page?.before ? older : latest;
    });
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);
    store.setCacheScope(7, { userId: 1, nodeName: 'local', sessionId: 'sess-1' });

    await store.loadHistory(7, 'sess-1');
    expect(store.hasOlderHistory(7)).toBe(true);
    expect(emit).toHaveBeenCalledWith('session:history-page', { cardId: 7, page: {} });

    await store.loadOlderHistory(7);

    const contents = store
      .getSession(7)!
      .accumulator.conversation.filter((e) => e.kind === 'user')
      .map((e) => (e.kind === 'user' ? e.content : ''));
    expect(contents).toEqual(['one', 'two', 'three', 'four']);
    expect(store.hasOlderHistory(7)).toBe(false);
    expect(store.hasNewerHistory(7)).toBe(false);
  });
});

// A refused stop used to poll agent:stop every second until the page reloaded,
// which spammed the server with 409 card_not_running replies.
describe('SessionStore stop retries', () => {
  it('caps the stop attempts and re-reads the status instead of polling forever', () => {
    vi.useFakeTimers();
    const socketEmit = vi.fn();
    const emit = vi.fn().mockResolvedValue(undefined);
    const store = new SessionStore();
    store.setWs({ emit, socket: { emit: socketEmit } } as unknown as WsClient);

    store.stopSession(1011);
    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();

    expect(socketEmit).toHaveBeenCalledTimes(5);
    expect(store.stoppingCards.has(1011)).toBe(false);
    expect(emit).toHaveBeenCalledWith('agent:status', { cardId: 1011 });
  });
});

// A reconnect used to refetch every subscribed card at once. With several
// sessions open that froze the board, because each reload re-ingested a full
// transcript on the main thread.
describe('SessionStore resubscribeAll', () => {
  function statusFor(cardId: number, sessionId: string) {
    return {
      cardId,
      active: false,
      status: 'completed' as const,
      sessionId,
      promptsSent: 0,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
    };
  }

  it('reloads history only for cards with a mounted view', async () => {
    const emit = vi.fn().mockResolvedValue({ messages: [] });
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);

    store.handleAgentStatus(statusFor(1, 'sess-1'));
    store.handleAgentStatus(statusFor(2, 'sess-2'));
    store.subscribedCards.add(1);
    store.subscribedCards.add(2);
    emit.mockClear();

    store.addViewer(1);
    await store.resubscribeAll();

    expect(emit).toHaveBeenCalledWith('session:history-page', { cardId: 1, page: {} });
    // A session id is enough to page: the cache scope is only a cache key, so a card
    // this client has never cached still fetches one page instead of the whole
    // transcript. Only a card with no session falls back to session:load.
    expect(emit).not.toHaveBeenCalledWith('session:load', { cardId: 1, sessionId: 'sess-1' });
    expect(emit).not.toHaveBeenCalledWith('session:load', { cardId: 2, sessionId: 'sess-2' });
    expect(emit).toHaveBeenCalledWith('agent:status', { cardId: 2 });
  });

  it('asks for the events after the replica cursor after a reconnect', async () => {
    // A socket break can lose transcript events. The replica keeps its cursor, so
    // the reconnect asks for the events after it and the node replays only those,
    // instead of the client rebuilding the whole transcript state.
    const snapshot = {
      cursor: { streamId: 'stream-1', sequence: 1 },
      state: { baseline: [], baselineThrough: 0, overlay: [], events: [] },
    };
    const emit = vi.fn(async (event: string) =>
      event === 'session:transcript' ? { snapshot, replayed: false } : { messages: [] },
    );
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);
    store.setCacheScope(7, { userId: 1, nodeName: 'local', sessionId: 'sess-1' });
    store.handleAgentStatus({ ...statusFor(7, 'sess-1'), active: true, status: 'running' });
    store.subscribedCards.add(7);
    store.addViewer(7);

    // A live transcript event builds the replica the view paints from.
    store.ingestSdkMessage(7, {
      type: 'transcript_event',
      envelope: { cursor: { streamId: 'stream-1', sequence: 1 }, event: { type: 'pi_event', event: {} } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Guard the setup: without a replica this test would pass for the wrong reason.
    expect((store as unknown as { replicas: Map<number, unknown> }).replicas.has(7)).toBe(true);

    emit.mockClear();
    await store.resubscribeAll();

    // The cursor travels with the request, so the node answers with the delta — or
    // with a snapshot when it cannot replay — and never with the whole transcript.
    expect(emit).toHaveBeenCalledWith('session:transcript', {
      cardId: 7,
      cursor: { streamId: 'stream-1', sequence: 1 },
    });
    expect(emit).not.toHaveBeenCalledWith('session:load', { cardId: 7, sessionId: 'sess-1' });
  });
});

// A card view re-runs its mount effect as the board data and the account arrive,
// and each run asked for the same session again. Those repeats were queued, so one
// card open fetched the same history page three times.
describe('SessionStore history loading', () => {
  function runningStatus(cardId: number, sessionId: string) {
    return {
      cardId,
      active: true,
      status: 'running' as const,
      sessionId,
      promptsSent: 1,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
    };
  }

  it('does not fetch history twice when the same load is already in flight', async () => {
    const pending: Array<(page: TranscriptHistoryPage) => void> = [];
    const emit = vi.fn(async (event: string) => {
      if (event !== 'session:history-page') return { messages: [] };
      return new Promise<TranscriptHistoryPage>((resolve) => {
        pending.push(resolve);
      });
    });
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);
    store.setCacheScope(7, { userId: 1, nodeName: 'local', sessionId: 'sess-1' });
    store.handleAgentStatus({ ...runningStatus(7, 'sess-1'), active: false, status: 'completed' });

    const first = store.loadHistory(7, 'sess-1');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await store.loadHistory(7, 'sess-1'); // the mount effect runs again
    // The repeat must not be queued as a follow-up fetch.
    expect([...(store as unknown as { pendingLoads: Map<number, unknown> }).pendingLoads.keys()]).toEqual([]);
    pending[0]!(historyPage({ records: [] }));
    await first;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(emit.mock.calls.filter((call) => call[0] === 'session:history-page')).toHaveLength(1);
  });

  it('still reloads when a turn ends while the same load is in flight', async () => {
    const pending: Array<(page: TranscriptHistoryPage) => void> = [];
    const emit = vi.fn((event: string) => {
      if (event === 'session:history-page') {
        return new Promise<TranscriptHistoryPage>((resolve) => pending.push(resolve));
      }
      return Promise.resolve(historyPage({ records: [] }));
    });
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);
    store.setCacheScope(7, { userId: 1, nodeName: 'local', sessionId: 'sess-turn' });
    store.handleAgentStatus(runningStatus(7, 'sess-turn'));

    const first = store.loadHistory(7, 'sess-turn');
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    // The backfill that catches the final assistant message must survive the dedupe.
    store.handleAgentStatus({ ...runningStatus(7, 'sess-turn'), active: false, status: 'completed' });
    const fetches = () =>
      emit.mock.calls.filter((call) => call[0] === 'session:load' || call[0] === 'session:history-page');
    pending[0]!(historyPage({ sessionId: 'sess-turn', records: [] }));
    await first;
    await vi.waitFor(() => expect(fetches()).toHaveLength(2));
  });

  // A running card used to skip the cache and the diff entirely and refetch every
  // message through session:load, on every reconnect and every page load.
  it('loads a running card from the paged history instead of the whole transcript', async () => {
    const emit = vi.fn(async (event: string) => {
      if (event === 'session:history-page') {
        return historyPage({ sessionId: 'sess-live', records: [{ id: 'id1', message: userHistory('id1', 'one') }] });
      }
      return { messages: [userHistory('id1', 'one')] };
    });
    const store = new SessionStore();
    store.setWs({ emit } as unknown as WsClient);
    store.setCacheScope(7, { userId: 1, nodeName: 'local', sessionId: 'sess-live' });
    store.handleAgentStatus({ ...runningStatus(7, 'sess-live'), active: true, status: 'running' });

    await store.loadHistory(7, 'sess-live');

    expect(emit).toHaveBeenCalledWith('session:history-page', { cardId: 7, page: {} });
    expect(emit).not.toHaveBeenCalledWith('session:load', expect.anything());
    expect(store.getSession(7)!.historyLoaded).toBe(true);
  });

  // A focused card is usually running. Scroll-up used to be refused outright for a
  // running card, and a live event during the fetch threw the older page away.
  it('pages backwards on a running card and keeps the page when a live event lands', async () => {
    const latest = historyPage({
      sessionId: 'sess-scroll',
      records: [{ id: 'id3', message: userHistory('id3', 'three') }],
      before: 'id3',
      after: 'id3',
      hasOlder: true,
    });
    const older = historyPage({
      sessionId: 'sess-scroll',
      records: [{ id: 'id2', message: userHistory('id2', 'two') }],
      before: 'id2',
      after: 'id2',
    });
    const store = new SessionStore();
    const emit = vi.fn(async (event: string, data: { page?: { before?: string } }) => {
      if (event !== 'session:history-page') return { messages: [] };
      if (!data.page?.before) return latest;
      // A live event during the fetch must not turn the older page away.
      store.ingestSdkMessage(7, {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-1', role: 'assistant', model: 'test-model', content: [] },
        },
      } as SdkMessage);
      return older;
    });
    store.setWs({ emit } as unknown as WsClient);
    store.setCacheScope(7, { userId: 1, nodeName: 'local', sessionId: 'sess-scroll' });
    store.handleAgentStatus({ ...runningStatus(7, 'sess-scroll'), active: true, status: 'running' });
    await store.loadHistory(7, 'sess-scroll');

    await store.loadOlderHistory(7);

    const contents = store
      .getSession(7)!
      .accumulator.conversation.filter((entry) => entry.kind === 'user')
      .map((entry) => (entry.kind === 'user' ? entry.content : ''));
    expect(contents).toEqual(['two', 'three']);
  });

  // orcd answers a cursor it can replay with the missed events and no snapshot.
  // Those events arrive while the request is in flight, so dropping them would
  // leave a hole where a snapshot should not have been needed.
  it('applies replayed events to the replica it already holds', async () => {
    const snapshot = {
      cursor: { streamId: 'stream-1', sequence: 1 },
      state: { baseline: [], baselineThrough: 0, overlay: [], events: [] },
    };
    const envelope = (sequence: number) => ({
      cursor: { streamId: 'stream-1', sequence },
      event: { type: 'pi_event', event: {} },
    });
    const store = new SessionStore();
    const emit = vi.fn(async (event: string, data: { cursor?: unknown }) => {
      if (event !== 'session:transcript') return { messages: [] };
      if (!data.cursor) return { snapshot, replayed: false };
      store.ingestSdkMessage(7, { type: 'transcript_event', envelope: envelope(2) });
      return { snapshot: null, replayed: true };
    });
    store.setWs({ emit } as unknown as WsClient);
    store.setCacheScope(7, { userId: 1, nodeName: 'local', sessionId: 'sess-replay' });
    store.handleAgentStatus({ ...runningStatus(7, 'sess-replay'), active: true, status: 'running' });
    const cursor = () =>
      (store as unknown as { replicas: Map<number, { currentCursor(): unknown }> }).replicas.get(7)?.currentCursor();

    store.ingestSdkMessage(7, { type: 'transcript_event', envelope: envelope(1) });
    await vi.waitFor(() => expect(cursor()).toEqual({ streamId: 'stream-1', sequence: 1 }));

    await store.loadHistory(7, 'sess-replay', { force: true });

    expect(emit).toHaveBeenCalledWith('session:transcript', {
      cardId: 7,
      cursor: { streamId: 'stream-1', sequence: 1 },
    });
    await vi.waitFor(() => expect(cursor()).toEqual({ streamId: 'stream-1', sequence: 2 }));
  });
});
