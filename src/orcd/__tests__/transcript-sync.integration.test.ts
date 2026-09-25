import { TranscriptReplica } from '../../shared/transcript-reducer';
import { readFile } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import type { AgentSessionEvent, InlineExtension, SessionEntry } from '@earendil-works/pi-coding-agent';
import { buildContextEntries, sessionEntryToContextMessages, SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { displayedMessages, TranscriptSync } from '../transcript-sync';
import type {
  ReplayDecision,
  TranscriptCursor,
  TranscriptEnvelope,
  TranscriptEvent,
  TranscriptState,
} from '../../shared/transcript-sync';
import { expect, it } from 'vitest';
import { Type } from 'typebox';
import { createTranscriptSyncFixture } from './transcript-sync-fixture';

function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

function text(entry: SessionEntry): string | undefined {
  if (entry.type !== 'message' || entry.message.role !== 'assistant') return undefined;
  return contentText(entry.message.content);
}

it('settles queued identical prompts only after final message replacement is durable', async () => {
  let releaseReplacement: (() => void) | undefined;
  const replacementGate = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
  let messageEndRuntimeMessageCount: number | undefined;
  let messageEndPersistedEntryCount: number | undefined;
  let settledEntries: SessionEntry[] | undefined;
  let settledSessionFile: string | undefined;
  let replacementStarted: (() => void) | undefined;
  const replacementStartedGate = new Promise<void>((resolve) => {
    replacementStarted = resolve;
  });
  let releaseSettled: (() => void) | undefined;
  let lowLevelIdle = false;
  let lowLevelIdleAtSettledExtensionStart: boolean | undefined;
  const settledExtensionGate = new Promise<void>((resolve) => {
    releaseSettled = resolve;
  });
  let settledExtensionStarted: (() => void) | undefined;
  const settledExtensionStartedGate = new Promise<void>((resolve) => {
    settledExtensionStarted = resolve;
  });
  const extension: InlineExtension = {
    name: 'delayed-final-replacement',
    factory: (pi) => {
      pi.on('message_end', async (event, ctx) => {
        if (event.message.role !== 'assistant' || textContent(event.message) !== 'third raw') return;
        messageEndRuntimeMessageCount = fixture.runtime.session.agent.state.messages.length;
        messageEndPersistedEntryCount = SessionManager.open(ctx.sessionManager.getSessionFile()!)
          .getEntries()
          .filter((entry) => entry.type === 'message').length;
        replacementStarted?.();
        await replacementGate;
        return {
          message: {
            ...event.message,
            content: [{ type: 'text', text: 'third final' }],
          },
        };
      });
      pi.on('agent_settled', async () => {
        lowLevelIdleAtSettledExtensionStart = lowLevelIdle;
        settledExtensionStarted?.();
        await settledExtensionGate;
      });
    },
  };
  const fixture = await createTranscriptSyncFixture(extension);
  const events: AgentSessionEvent[] = [];
  let unsubscribe: (() => void) | undefined;

  try {
    fixture.faux.setResponses([
      fauxAssistantMessage('initial'),
      fauxAssistantMessage('second'),
      fauxAssistantMessage('third raw'),
    ]);
    const session = fixture.runtime.session;
    const streamingFlags: boolean[] = [];
    let queued = false;
    let lowLevelIdleEventCount: number | undefined;
    let lowLevelIdleWait: Promise<void> | undefined;
    const agentEndStreamingFlags: Array<{ session: boolean; agent: boolean }> = [];
    let settled = false;
    let settle: (() => void) | undefined;
    const settledGate = new Promise<void>((resolve) => {
      settle = resolve;
    });

    unsubscribe = session.subscribe((event) => {
      events.push(structuredClone(event));
      streamingFlags.push(session.isStreaming);
      if (event.type === 'message_update' && !lowLevelIdleWait) {
        lowLevelIdleWait = session.agent.waitForIdle().then(() => {
          lowLevelIdle = true;
          lowLevelIdleEventCount = events.length;
        });
      }
      if (
        event.type === 'message_end' &&
        event.message.role === 'assistant' &&
        textContent(event.message) === 'initial' &&
        !queued
      ) {
        queued = true;
        void session.prompt('same follow-up', { streamingBehavior: 'followUp' });
        void session.prompt('same follow-up', { streamingBehavior: 'followUp' });
      }
      if (event.type === 'agent_end') {
        agentEndStreamingFlags.push({ session: session.isStreaming, agent: session.agent.state.isStreaming });
      }
      if (event.type === 'agent_settled') {
        settled = true;
        settledSessionFile = session.sessionFile;
        settledEntries = SessionManager.open(session.sessionFile!).getEntries();
        settle?.();
      }
    });

    const prompt = session.prompt('initial prompt');
    await replacementStartedGate;
    expect(lowLevelIdleWait).toBeDefined();
    expect(settled).toBe(false);
    expect(events.some((event) => event.type === 'agent_settled')).toBe(false);

    releaseReplacement?.();
    await settledExtensionStartedGate;
    await lowLevelIdleWait;
    expect(lowLevelIdle).toBe(true);
    expect(lowLevelIdleEventCount).toBeDefined();
    expect(lowLevelIdleAtSettledExtensionStart).toBe(true);
    expect(lowLevelIdleEventCount).toBe(events.length);
    expect(settled).toBe(false);
    expect(events.some((event) => event.type === 'agent_settled')).toBe(false);

    releaseSettled?.();
    await prompt;
    await settledGate;

    expect(messageEndRuntimeMessageCount).toBe(7);
    expect(messageEndPersistedEntryCount).toBe(6);
    expect(messageEndRuntimeMessageCount).not.toBe(messageEndPersistedEntryCount);
    expect(streamingFlags).toContain(true);
    expect(streamingFlags.at(-1)).toBe(false);
    expect(agentEndStreamingFlags).toContainEqual({ session: true, agent: true });
    expect(events.map((event) => event.type).indexOf('agent_end')).toBeLessThan(
      events.map((event) => event.type).indexOf('agent_settled'),
    );
    expect(settledSessionFile).toBeDefined();
    expect(settledEntries).toBeDefined();
    const messages = settledEntries!.filter((entry) => entry.type === 'message');
    // 7 = the persisted system prompt/tool loadout entry plus the 3 user and 3 assistant turns.
    expect(messages).toHaveLength(7);
    expect(messages.map((entry) => entry.id)).toHaveLength(new Set(messages.map((entry) => entry.id)).size);
    const userMessages = messages.filter(
      (
        entry,
      ): entry is SessionEntry & {
        type: 'message';
        message: { role: 'user'; content: string | Array<{ type: string; text?: string }> };
      } => entry.message.role === 'user',
    );
    expect(userMessages.map((entry) => contentText(entry.message.content))).toEqual([
      'initial prompt',
      'same follow-up',
      'same follow-up',
    ]);
    expect(messages.map(text).filter(Boolean)).toEqual(['initial', 'second', 'third final']);
    expect(await readFile(settledSessionFile!, 'utf8')).toContain('third final');
  } finally {
    unsubscribe?.();
    await fixture.dispose();
  }
});

function textContent(message: Extract<AgentSessionEvent, { type: 'message_end' }>['message']): string {
  if (message.role !== 'assistant') return '';
  return contentText(message.content);
}

function displayedText(replica: TranscriptReplica): string[] {
  return displayedMessages(replica.snapshot().state).map((message) => {
    if (message.role === 'assistant' || message.role === 'user') return contentText(message.content);
    return message.role;
  });
}

interface WireSnapshot {
  type: 'snapshot';
  cursor: TranscriptCursor;
  state: TranscriptState;
}

interface WireEvents {
  type: 'events';
  events: TranscriptEnvelope<TranscriptEvent>[];
}

type WireMessage = WireSnapshot | WireEvents;

function writeWire(socket: Socket, message: WireMessage): void {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`);
}

async function createTranscriptWire(sync: TranscriptSync): Promise<{
  port: number;
  publish(envelope: TranscriptEnvelope<TranscriptEvent>): void;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let rest = '';
    socket.on('data', (chunk: Buffer) => {
      rest += chunk.toString();
      let end = rest.indexOf('\n');
      while (end >= 0) {
        const line = rest.slice(0, end);
        rest = rest.slice(end + 1);
        const cursor = JSON.parse(line) as TranscriptCursor | undefined;
        const decision: ReplayDecision<TranscriptEvent, TranscriptState> = sync.replaySince(cursor);
        if (decision.type === 'snapshot')
          writeWire(socket, { type: 'snapshot', cursor: decision.cursor, state: decision.state });
        else writeWire(socket, { type: 'events', events: decision.events });
        end = rest.indexOf('\n');
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback TCP address');
  return {
    port: address.port,
    publish(envelope) {
      for (const socket of sockets) writeWire(socket, { type: 'events', events: [envelope] });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

async function connectWire(
  port: number,
  replica: TranscriptReplica,
  cursor: TranscriptCursor | undefined,
): Promise<{
  socket: Socket;
  frames: WireMessage[];
  waitForFrames(count: number): Promise<void>;
}> {
  const socket = connect(port, '127.0.0.1');
  const frames: WireMessage[] = [];
  const waiters: Array<{ count: number; resolve(): void }> = [];
  let rest = '';
  socket.on('data', (chunk: Buffer) => {
    rest += chunk.toString();
    let end = rest.indexOf('\n');
    while (end >= 0) {
      const message = JSON.parse(rest.slice(0, end)) as WireMessage;
      rest = rest.slice(end + 1);
      frames.push(message);
      if (message.type === 'snapshot')
        expect(replica.applySnapshot(message.cursor, message.state)).toEqual({ type: 'accepted' });
      else for (const event of message.events) expect(replica.accept(event)).toEqual({ type: 'accepted' });
      for (const waiter of waiters.splice(0)) {
        if (frames.length >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
      end = rest.indexOf('\n');
    }
  });
  await once(socket, 'connect');
  socket.write(`${JSON.stringify(cursor ?? null)}\n`);
  return {
    socket,
    frames,
    waitForFrames(count) {
      if (frames.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

it('recovers TCP transcript snapshots and retained replays without duplicate display content', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused: (() => void) | undefined;
  const pausedGate = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const fixture = await createTranscriptSyncFixture({
    name: 'pause-stream',
    factory: (pi) => {
      pi.on('message_update', async (event) => {
        if (event.assistantMessageEvent.type !== 'text_delta') return;
        paused?.();
        await gate;
      });
    },
  });
  const sync = new TranscriptSync('tcp-stream', [], 3);
  const retainedSync = new TranscriptSync('tcp-retained-stream', [], 50);
  const wire = await createTranscriptWire(sync);
  const retainedWire = await createTranscriptWire(retainedSync);
  let unsubscribe: (() => void) | undefined;
  try {
    fixture.faux.setResponses([fauxAssistantMessage('abcdef')]);
    unsubscribe = fixture.runtime.session.subscribe((event) => {
      wire.publish(sync.accept(event));
      retainedWire.publish(retainedSync.accept(event));
    });
    const connected = await connectWire(wire.port, new TranscriptReplica(), undefined);
    await connected.waitForFrames(1);
    const initial = connected.frames[0]!;
    if (initial.type !== 'snapshot') throw new Error('Expected initial snapshot');
    const run = fixture.runtime.session.prompt('first');
    await pausedGate;
    await connected.waitForFrames(2);
    const latestFrame = connected.frames.at(-1)!;
    const partialCursor = latestFrame.type === 'events' ? latestFrame.events.at(-1)!.cursor : latestFrame.cursor;
    const retainedSnapshot = connected.frames.find((frame): frame is WireSnapshot => frame.type === 'snapshot');
    expect(retainedSnapshot).toBeDefined();
    connected.socket.destroy();
    release?.();
    await run;

    const overflowReplica = new TranscriptReplica();
    const overflow = await connectWire(wire.port, overflowReplica, partialCursor);
    await overflow.waitForFrames(1);
    expect(overflow.frames[0]!.type).toBe('snapshot');
    const beforeRelease = overflow.frames.length;
    fixture.faux.appendResponses([fauxAssistantMessage('second')]);
    await fixture.runtime.session.prompt('next');
    await overflow.waitForFrames(beforeRelease + 1);
    expect(displayedText(overflowReplica)).toEqual(['first', 'abcdef', 'next', 'second']);
    expect(new Set(displayedText(overflowReplica)).size).toBe(displayedText(overflowReplica).length);
    overflow.socket.destroy();

    const retainedSnapshotReplica = new TranscriptReplica();
    const retainedSnapshotWire = await connectWire(retainedWire.port, retainedSnapshotReplica, {
      streamId: 'foreign',
      sequence: 0,
    });
    await retainedSnapshotWire.waitForFrames(1);
    const currentSnapshot = retainedSnapshotWire.frames[0]!;
    if (currentSnapshot.type !== 'snapshot') throw new Error('Expected retained snapshot');
    retainedSnapshotWire.socket.destroy();
    fixture.faux.appendResponses([fauxAssistantMessage('third')]);
    await fixture.runtime.session.prompt('last');
    const retainedReplica = new TranscriptReplica();
    expect(retainedReplica.applySnapshot(currentSnapshot.cursor, currentSnapshot.state)).toEqual({ type: 'accepted' });
    const retained = await connectWire(retainedWire.port, retainedReplica, currentSnapshot.cursor);
    await retained.waitForFrames(1);
    expect(retained.frames[0]!.type).toBe('events');
    expect(displayedText(retainedReplica)).toEqual(['first', 'abcdef', 'next', 'second', 'last', 'third']);
    retained.socket.destroy();
  } finally {
    unsubscribe?.();
    await wire.close();
    await retainedWire.close();
    await fixture.dispose();
  }
});

it('replaces stale runtime epochs and forks active streams through public runtime APIs', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused: (() => void) | undefined;
  const pausedGate = new Promise<void>((resolve) => {
    paused = resolve;
  });
  let pauseActiveResponse = false;
  const fixture = await createTranscriptSyncFixture({
    name: 'pause-for-replacement',
    factory: (pi) => {
      pi.on('message_update', async (event) => {
        if (pauseActiveResponse && event.assistantMessageEvent.type === 'text_delta') {
          paused?.();
          await gate;
        }
      });
    },
  });
  let unsubscribe: (() => void) | undefined;
  try {
    fixture.faux.setResponses([
      fauxAssistantMessage('seed'),
      fauxAssistantMessage('partial'),
      fauxAssistantMessage('forked'),
    ]);
    const original = fixture.runtime.session;
    const oldSync = new TranscriptSync('old-epoch', [], 10);
    unsubscribe = original.subscribe((event) => oldSync.accept(event));
    await original.prompt('persisted');
    const persistedFile = original.sessionFile;
    expect(persistedFile).toBeDefined();
    pauseActiveResponse = true;
    const run = original.prompt('active');
    await pausedGate;
    const oldCursor = oldSync.snapshot().cursor;

    const forkEntry = original.sessionManager
      .getEntries()
      .find(
        (entry) =>
          entry.type === 'message' &&
          entry.message.role === 'user' &&
          contentText(entry.message.content) === 'persisted',
      );
    expect(forkEntry).toBeDefined();
    const fork = fixture.runtime.fork(forkEntry!.id);
    release?.();
    await fork;
    unsubscribe?.();
    const replacement = fixture.runtime.session;
    const replacementSync = new TranscriptSync('fork-epoch', replacement.sessionManager.getEntries(), 10);
    const view = new TranscriptReplica();
    expect(view.applySnapshot(replacementSync.snapshot().cursor, replacementSync.snapshot().state)).toEqual({
      type: 'accepted',
    });
    const replacementUnsubscribe = replacement.subscribe((event) => {
      const envelope = replacementSync.accept(event);
      expect(view.accept(envelope)).toEqual({ type: 'accepted' });
    });
    await replacement.prompt('replacement prompt');
    replacementUnsubscribe();
    await run.catch(() => undefined);
    const expectedReplacement = displayedText(view);
    expect(expectedReplacement).toContain('forked');
    const oldEvents = oldSync.replaySince(undefined);
    if (oldEvents.type === 'replay') {
      for (const event of oldEvents.events) expect(view.accept(event)).toEqual({ type: 'snapshot_required' });
    }
    expect(displayedText(view)).toEqual(expectedReplacement);

    await fixture.recreate(persistedFile!);
    const recreated = fixture.runtime.session;
    const recreatedSync = new TranscriptSync('recreated-epoch', recreated.sessionManager.getEntries(), 10);
    expect(recreatedSync.replaySince(oldCursor).type).toBe('snapshot');
    expect(displayedText(new TranscriptReplica())).toEqual([]);
    const restored = displayedMessages(recreatedSync.snapshot().state).map((message) =>
      message.role === 'user'
        ? contentText(message.content)
        : message.role === 'assistant'
          ? contentText(message.content)
          : message.role,
    );
    expect(restored).toContain('persisted');
    expect(restored).toContain('seed');
  } finally {
    unsubscribe?.();
    release?.();
    await fixture.dispose();
  }
});

it('projects Pi compaction context while preserving its append-only entry log', async () => {
  const fixture = await createTranscriptSyncFixture({ name: 'compaction-summary', factory: () => {} });
  try {
    fixture.faux.setResponses([fauxAssistantMessage('old answer'), fauxAssistantMessage('new answer')]);
    await fixture.runtime.session.prompt('old prompt');
    await fixture.runtime.session.prompt('new prompt');
    const manager = fixture.runtime.session.sessionManager;
    const entries = manager.getEntries();
    const firstKept = entries.find(
      (entry) =>
        entry.type === 'message' &&
        entry.message.role === 'user' &&
        contentText(entry.message.content) === 'new prompt',
    );
    expect(firstKept).toBeDefined();
    manager.appendCompaction('synthetic summary', firstKept!.id, 100);
    const context = buildContextEntries(manager.getEntries());
    const projected = context.flatMap((entry) => sessionEntryToContextMessages(entry));
    expect(
      projected.map((message) =>
        message.role === 'compactionSummary'
          ? message.summary
          : message.role === 'user'
            ? contentText(message.content)
            : message.role === 'assistant'
              ? contentText(message.content)
              : message.role,
      ),
    ).toEqual([
      // Pi 0.86+ persists the system prompt/tool loadout as a leading system message.
      // It is model context; Orchestrel's display projection drops it (see projectEntries).
      'system',
      'synthetic summary',
      'new prompt',
      'new answer',
    ]);
    expect(manager.getEntries()).toHaveLength(entries.length + 1);
    expect(
      manager
        .getEntries()
        .some(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'user' &&
            contentText(entry.message.content) === 'old prompt',
        ),
    ).toBe(true);
  } finally {
    await fixture.dispose();
  }
});

it('measures retained payloads for a long unsettled tool loop and releases the overlay at settlement', async () => {
  const rounds = 16;
  const outputBytes = 65_536;
  let settledStarted: (() => void) | undefined;
  const settledStartedGate = new Promise<void>((resolve) => {
    settledStarted = resolve;
  });
  let releaseSettlement: (() => void) | undefined;
  const settlementGate = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  const output = 'x'.repeat(outputBytes);
  const fixture = await createTranscriptSyncFixture({
    name: 'large-tool-loop',
    factory: (pi) => {
      pi.registerTool({
        name: 'large_output',
        label: 'large output',
        description: 'Returns deterministic synthetic measurement content.',
        parameters: Type.Object({ round: Type.Integer() }),
        async execute() {
          return { content: [{ type: 'text', text: output }], details: undefined };
        },
      });
      pi.on('agent_settled', async () => {
        settledStarted?.();
        await settlementGate;
      });
    },
  });
  const sync = new TranscriptSync('measurement-stream', [], 32, 262_144);
  let unsubscribe: (() => void) | undefined;
  try {
    fixture.faux.setResponses([
      ...Array.from({ length: rounds }, (_, round) => fauxAssistantMessage([fauxToolCall('large_output', { round })])),
      fauxAssistantMessage('complete'),
    ]);
    unsubscribe = fixture.runtime.session.subscribe((event) => sync.accept(event));
    const heapBefore = process.memoryUsage().heapUsed;
    const run = fixture.runtime.session.prompt('measure tool retention');
    await settledStartedGate;

    const unsettled = sync.snapshot();
    const unsettledBytes = encodedBytes(unsettled.state);
    const replay = sync.replaySince({ streamId: 'measurement-stream', sequence: 0 });
    const replayBytes = replay.type === 'replay' ? encodedBytes(replay.events) : 0;
    const heapUnsettled = process.memoryUsage().heapUsed;
    expect(unsettled.state.baseline).toHaveLength(0);
    expect(unsettled.state.overlay.length).toBeGreaterThanOrEqual(rounds * 2);
    // Pi's public tool-result path retains an excerpt per synthetic output.
    // This still proves every completed tool-loop record remains in the unsettled overlay.
    expect(unsettledBytes).toBeGreaterThan(encodedBytes(fixture.runtime.session.sessionManager.getEntries()));
    expect(replay.type).toBe('snapshot');
    expect(replayBytes).toBe(0);

    releaseSettlement?.();
    await run;
    const settled = sync.settle(fixture.runtime.session.sessionManager.getEntries());
    const afterSettlement = sync.snapshot();
    const baselineBytes = encodedBytes(afterSettlement.state.baseline);
    const overlayBytes = encodedBytes(afterSettlement.state.overlay);
    const retainedReplay = sync.replaySince({ streamId: 'measurement-stream', sequence: settled.cursor.sequence - 1 });
    const retainedReplayBytes = retainedReplay.type === 'replay' ? encodedBytes(retainedReplay.events) : 0;
    const heapSettled = process.memoryUsage().heapUsed;

    expect(overlayBytes).toBe(2);
    expect(afterSettlement.state.overlay).toEqual([]);
    expect(baselineBytes).toBeGreaterThan(0);
    expect(retainedReplayBytes).toBeLessThanOrEqual(262_144);
    // Heap is process-wide and GC-managed; record it without treating a GC cycle as a reducer failure.
    expect(heapBefore).toBeGreaterThan(0);
    expect(heapUnsettled).toBeGreaterThan(0);
    expect(heapSettled).toBeGreaterThan(0);
  } finally {
    releaseSettlement?.();
    unsubscribe?.();
    await fixture.dispose();
  }
});

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

it('replays sequenced snapshots across overflow and delayed settlement without duplicate messages', async () => {
  const fixture = await createTranscriptSyncFixture({ name: 'transcript-sync', factory: () => {} });
  const sync = new TranscriptSync('stream-one', [], 3);
  const replica = new TranscriptReplica();
  let unsubscribe: (() => void) | undefined;
  try {
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search', { query: 'first', page: 2 })]),
      fauxAssistantMessage('second'),
    ]);
    const session = fixture.runtime.session;
    const events = [] as ReturnType<TranscriptSync['accept']>[];
    const settlements = [] as ReturnType<TranscriptSync['settle']>[];
    const settledSnapshots = [] as ReturnType<TranscriptSync['snapshot']>[];
    let firstPartial: ReturnType<TranscriptSync['snapshot']> | undefined;

    unsubscribe = session.subscribe((event) => {
      if (event.type === 'agent_settled') {
        settlements.push(sync.settle(session.sessionManager.getEntries()));
        settledSnapshots.push(sync.snapshot());
        return;
      }
      const envelope = sync.accept(event);
      if (envelope.event.type === 'message_delta' && 'delta' in envelope.event.update.event) {
        expect(envelope.event.update.content).toBeUndefined();
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'toolcall_delta') {
        firstPartial = sync.snapshot();
      }
      events.push(envelope);
    });

    await session.prompt('first prompt');
    expect(settlements).toHaveLength(1);
    expect(firstPartial).toBeDefined();
    const partialTool = firstPartial!.state.overlay.find((message) => message.message.role === 'assistant')
      ?.toolInput[0];
    expect(partialTool).toEqual({
      raw: '{"query":"first","page":2}',
      parsed: { query: 'first', page: 2 },
    });
    const overflow = sync.replaySince({ streamId: 'stream-one', sequence: 0 });
    expect(overflow.type).toBe('snapshot');
    const byteBounded = new TranscriptSync('byte-bounded', [], 3, 1);
    byteBounded.accept(events[0]!.event.type === 'pi_event' ? events[0]!.event.event : { type: 'agent_start' });
    expect(byteBounded.replaySince({ streamId: 'byte-bounded', sequence: 0 }).type).toBe('snapshot');
    if (overflow.type === 'snapshot') {
      expect(displayedMessages(overflow.state).map((message) => message.role)).toContain('toolResult');
    }

    // The first settled snapshot is deliberately delayed while a newer run begins.
    await session.prompt('next prompt');
    expect(settlements).toHaveLength(2);

    const firstSnapshot = firstPartial!;
    const firstSettlement = settlements[0]!;
    const firstSettledSnapshot = settledSnapshots[0]!;
    const secondSettlement = settlements[1]!;
    expect(replica.applySnapshot(firstSnapshot.cursor, firstSnapshot.state).type).toBe('accepted');
    expect(replica.accept(firstSettlement).type).toBe('snapshot_required');
    expect(replica.applySnapshot(firstSettledSnapshot.cursor, firstSettledSnapshot.state).type).toBe('accepted');
    for (const event of events.filter((event) => event.cursor.sequence > firstSettledSnapshot.cursor.sequence)) {
      expect(replica.accept(event).type).toBe('accepted');
    }
    expect(replica.accept(secondSettlement).type).toBe('accepted');
    expect(displayedText(replica)).toContain('first prompt');
    expect(displayedText(replica)).toContain('toolResult');
    expect(displayedText(replica)).toContain('second');

    const other = new TranscriptSync('other-stream', [], 3);
    const otherSnapshot = other.snapshot();
    expect(replica.applySnapshot(otherSnapshot.cursor, otherSnapshot.state).type).toBe('snapshot_required');
    expect(displayedText(replica)).toContain('first prompt');
    expect(displayedText(replica)).toContain('second');
    expect(
      replica.applySnapshot(otherSnapshot.cursor, otherSnapshot.state, {
        fromStreamId: secondSettlement.cursor.streamId,
        toStreamId: 'other-stream',
      }).type,
    ).toBe('accepted');
    expect(
      replica.applySnapshot(secondSettlement.cursor, settledSnapshots[1]!.state, {
        fromStreamId: 'other-stream',
        toStreamId: secondSettlement.cursor.streamId,
      }).type,
    ).toBe('accepted');

    expect(replica.applySnapshot(firstSettledSnapshot.cursor, firstSettledSnapshot.state).type).toBe('duplicate');
    expect(replica.accept(firstSettlement).type).toBe('duplicate');
    expect(replica.accept(secondSettlement).type).toBe('duplicate');
    expect(displayedText(replica)).toContain('first prompt');
    expect(displayedText(replica)).toContain('second');
    expect(sync.replaySince({ streamId: 'other-stream', sequence: 0 }).type).toBe('snapshot');
    expect(sync.replaySince({ streamId: 'stream-one', sequence: 999 }).type).toBe('snapshot');
  } finally {
    unsubscribe?.();
    await fixture.dispose();
  }
});
