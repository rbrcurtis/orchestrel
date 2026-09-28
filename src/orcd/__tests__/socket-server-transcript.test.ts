import { describe, expect, it, vi } from 'vitest';
import { OrcdServer } from '../socket-server';
import { OrcdSession, type SessionEventCallback } from '../session';
import type { TranscriptState } from '../../shared/transcript-sync';

function createServer() {
  return new OrcdServer(
    { listen: { host: '127.0.0.1', port: 0 }, authToken: 'tok', name: 'local' },
    {
      test: {
        type: 'anthropic',
        baseUrl: '',
        apiKey: '',
        models: { test: { label: 'Test Model', modelID: 'test-model', contextWindow: 100 } },
        modelLabels: {},
      },
    },
    { provider: 'test', model: 'test-model' },
  );
}

function createClient() {
  return {
    socket: { writable: true, write: vi.fn() },
    subscriptions: new Map<string, SessionEventCallback>(),
    authenticated: true,
  };
}

function sentMessages(client: ReturnType<typeof createClient>): unknown[] {
  return client.socket.write.mock.calls.map((call) => JSON.parse(String(call[0])));
}

const EMPTY_STATE: TranscriptState = { baseline: [], baselineThrough: 0, overlay: [], events: [] };

// A subscriber that reconnects sends the cursor of the last event it applied. The
// node holds a bounded replay buffer, so it can answer with those events instead of
// rebuilding the whole transcript state — the state of a long session is megabytes,
// and the client used to pull it on every socket break.
describe('OrcdServer transcript cursor', () => {
  it('replays the events after a cursor instead of sending a snapshot', () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test',
      sessionId: 'cursor-session',
    });
    server.store.add(session);
    const envelope = {
      cursor: { streamId: 'stream-1', sequence: 2 },
      event: { type: 'pi_event' as const, event: { type: 'agent_start' } as never },
    };
    const replaySpy = vi.spyOn(session, 'replayTranscript').mockReturnValue({ type: 'replay', events: [envelope] });

    server['handleAction'](client as never, {
      action: 'get_transcript',
      requestId: 'req-1',
      sessionId: session.id,
      cursor: { streamId: 'stream-1', sequence: 1 },
    });

    expect(replaySpy).toHaveBeenCalledWith({ streamId: 'stream-1', sequence: 1 });
    // The missed events travel the normal event path, so the client applies them to
    // the replica that produced the cursor.
    expect(sentMessages(client)).toEqual([
      {
        type: 'stream_event',
        sessionId: session.id,
        event: { type: 'transcript_event', envelope },
      },
      { type: 'transcript_snapshot', requestId: 'req-1', snapshot: null, replayed: true },
    ]);
  });

  it('sends the snapshot when the cursor is too old to replay', () => {
    const server = createServer();
    const client = createClient();
    const session = new OrcdSession({
      cwd: '/tmp',
      model: 'test-model',
      provider: 'test',
      sessionId: 'stale-cursor-session',
    });
    server.store.add(session);
    const snapshot = { cursor: { streamId: 'stream-1', sequence: 9 }, state: EMPTY_STATE };
    vi.spyOn(session, 'replayTranscript').mockReturnValue({ type: 'snapshot', ...snapshot });
    vi.spyOn(session, 'getTranscriptSnapshot').mockReturnValue(snapshot);

    server['handleAction'](client as never, {
      action: 'get_transcript',
      requestId: 'req-2',
      sessionId: session.id,
      cursor: { streamId: 'stream-1', sequence: 1 },
    });

    expect(sentMessages(client)).toEqual([{ type: 'transcript_snapshot', requestId: 'req-2', snapshot }]);
  });
});
