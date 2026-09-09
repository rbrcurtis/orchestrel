import { readFile } from 'node:fs/promises';
import type { AgentSessionEvent, InlineExtension, SessionEntry } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { displayedMessages, TranscriptReplica, TranscriptSync } from '../transcript-sync';
import { expect, it } from 'vitest';
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
        messageEndPersistedEntryCount = SessionManager.open(ctx.sessionManager.getSessionFile()!).getEntries()
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
      if (event.type === 'message_end' && event.message.role === 'assistant' && textContent(event.message) === 'initial' && !queued) {
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

    expect(messageEndRuntimeMessageCount).toBe(6);
    expect(messageEndPersistedEntryCount).toBe(5);
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
    expect(messages).toHaveLength(6);
    expect(messages.map((entry) => entry.id)).toHaveLength(new Set(messages.map((entry) => entry.id)).size);
    const userMessages = messages.filter(
      (entry): entry is SessionEntry & { type: 'message'; message: { role: 'user'; content: string | Array<{ type: string; text?: string }> } } =>
        entry.message.role === 'user',
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

it('replays sequenced snapshots across overflow and delayed settlement without duplicate messages', async () => {
  const fixture = await createTranscriptSyncFixture({ name: 'transcript-sync', factory: () => {} });
  const sync = new TranscriptSync('stream-one', [], 3);
  const replica = new TranscriptReplica();
  let unsubscribe: (() => void) | undefined;
  try {
    fixture.faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')]);
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
      if (!firstPartial && event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        firstPartial = sync.snapshot();
      }
      events.push(envelope);
    });

    await session.prompt('first prompt');
    expect(settlements).toHaveLength(1);
    expect(firstPartial).toBeDefined();
    expect(displayedMessages(firstPartial!.state)
      .filter((message) => message.role === 'assistant')
      .map((message) => contentText(message.content))).toEqual(['first']);
    const overflow = sync.replaySince({ streamId: 'stream-one', sequence: 0 });
    expect(overflow.type).toBe('snapshot');
    const byteBounded = new TranscriptSync('byte-bounded', [], 3, 1);
    byteBounded.accept(events[0]!.event.type === 'pi_event' ? events[0]!.event.event : { type: 'agent_start' });
    expect(byteBounded.replaySince({ streamId: 'byte-bounded', sequence: 0 }).type).toBe('snapshot');
    if (overflow.type === 'snapshot') {
      expect(displayedMessages(overflow.state)
        .filter((message) => message.role === 'assistant')
        .map((message) => contentText(message.content))).toEqual(['first']);
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
    expect(displayedText(replica)).toEqual(['first prompt', 'first', 'next prompt', 'second']);

    expect(replica.applySnapshot(firstSettledSnapshot.cursor, firstSettledSnapshot.state).type).toBe('duplicate');
    expect(replica.accept(firstSettlement).type).toBe('duplicate');
    expect(replica.accept(secondSettlement).type).toBe('duplicate');
    expect(displayedText(replica)).toEqual(['first prompt', 'first', 'next prompt', 'second']);
    expect(sync.replaySince({ streamId: 'other-stream', sequence: 0 }).type).toBe('snapshot');
    expect(sync.replaySince({ streamId: 'stream-one', sequence: 999 }).type).toBe('snapshot');
  } finally {
    unsubscribe?.();
    await fixture.dispose();
  }
});
