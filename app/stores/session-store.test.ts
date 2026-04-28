import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from './session-store';
import type { SdkMessage } from '../lib/sdk-types';
import type { WsClient } from '../lib/ws-client';

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

  it('clears subagents when session exits', () => {
    const store = new SessionStore();
    startBlockingSubagent(store, 1011);

    store.handleSessionExit(1011);

    expect(store.getSession(1011)?.accumulator.subagents.size).toBe(0);
  });
});
