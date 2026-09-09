import { readFile } from 'node:fs/promises';
import type { AgentSessionEvent, InlineExtension, SessionEntry } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
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
