import { reduceTranscriptState } from '../shared/transcript-reducer';
import { TranscriptSpool } from './transcript-spool';
import { collectDisplayPrompts, originalPromptText } from '../lib/display-prompt';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { buildContextEntries, sessionEntryToContextMessages, type AgentSessionEvent, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type {
  ReplayDecision,
  TranscriptAssistantUpdate,
  TranscriptCursor,
  TranscriptEntryProjection,
  TranscriptEnvelope,
  TranscriptEvent,
  TranscriptState,
} from '../shared/transcript-sync';

/* oxlint-disable orchestrel/log-before-early-return -- pure synchronous state reducer has no session logger */

/**
 * Owns one session incarnation's transcript state. It reduces copied SDK events and
 * snapshots its own baseline plus live overlay; it never reads mutable Pi state when
 * serving a snapshot.
 */
export class TranscriptSync {
  private sequence = 0;
  private replayBytes = 0;
  private readonly replay: Array<{ envelope: TranscriptEnvelope<TranscriptEvent>; bytes: number }> = [];
  private readonly startSequences: number[] = [];
  private state: TranscriptState;
  private spool: TranscriptSpool | undefined;

  pageCompleted(before?: number) {
    return this.spool?.page(before) ?? { messages: [], before: 0, hasOlder: false };
  }

  dispose(): void {
    this.spool?.dispose();
    this.spool = undefined;
    this.replay.length = 0;
    this.state = { baseline: [], baselineThrough: this.sequence, overlay: [], events: [] };
  }

  boundLiveState(): void {
    let bytes = 0;
    let keep = this.state.overlay.length;
    for (let i = this.state.overlay.length - 1; i >= 0; i--) {
      bytes += byteSize(this.state.overlay[i]);
      if (this.state.overlay.length - i > 120 || bytes > 1_048_576) break;
      keep = i;
    }
    const active = this.state.overlay.findIndex((message) => this.startSequences.includes(message.startSequence));
    if (active >= 0) keep = Math.min(keep, active);
    if (keep === 0) return;
    this.spool ??= new TranscriptSpool();
    for (const message of this.state.overlay.slice(0, keep)) this.spool.append(message);
    this.state = { ...this.state, overlay: this.state.overlay.slice(keep), spooled: this.spool.length };
    // Old replay assumes those records are still in the in-memory overlay.
    // A snapshot explicitly advertises the paged-out prefix instead.
    this.replay.length = 0;
    this.replayBytes = 0;
  }

  constructor(
    readonly streamId: string,
    initialEntries: SessionEntry[],
    private readonly replayCapacity: number,
    private readonly replayByteCapacity = 1_000_000,
  ) {
    if (!Number.isSafeInteger(replayCapacity) || replayCapacity < 1) throw new Error('Transcript replay capacity must be a positive integer');
    if (!Number.isSafeInteger(replayByteCapacity) || replayByteCapacity < 1) {
      throw new Error('Transcript replay byte capacity must be a positive integer');
    }
    this.state = { baseline: projectEntries(initialEntries), baselineThrough: 0, overlay: [], events: [] };
  }

  accept(event: AgentSessionEvent): TranscriptEnvelope<TranscriptEvent> {
    const normalized = this.normalize(event);
    return this.sequenceEvent(normalized);
  }

  settle(entries: SessionEntry[]): TranscriptEnvelope<TranscriptEvent> {
    // Projection and sequencing share this synchronous call stack, so no newer SDK
    // event can claim a sequence between the authoritative source view and boundary.
    const event = this.sequenceEvent({ type: 'baseline_replaced', entries: projectEntries(entries), coveredThrough: this.sequence });
    this.spool?.dispose();
    this.spool = undefined;
    return event;
  }

  snapshot(): { cursor: TranscriptCursor; state: TranscriptState } {
    return structuredClone({ cursor: this.cursor(), state: this.state });
  }

  replaySince(cursor: TranscriptCursor | undefined): ReplayDecision<TranscriptEvent, TranscriptState> {
    if (!cursor || cursor.streamId !== this.streamId || cursor.sequence > this.sequence) return this.snapshotDecision();
    if (cursor.sequence === this.sequence) return { type: 'replay', events: [] };
    const oldest = this.replay[0]?.envelope;
    if (!oldest || cursor.sequence < oldest.cursor.sequence - 1) return this.snapshotDecision();
    const events = this.replay.map((item) => item.envelope).filter((event) => event.cursor.sequence > cursor.sequence);
    if (events[0]?.cursor.sequence !== cursor.sequence + 1) return this.snapshotDecision();
    return { type: 'replay', events: structuredClone(events) };
  }

  private sequenceEvent(event: TranscriptEvent): TranscriptEnvelope<TranscriptEvent> {
    const envelope = { cursor: { streamId: this.streamId, sequence: ++this.sequence }, event: structuredClone(event) };
    this.state = reduceTranscriptState(this.state, envelope.event);
    this.retain(envelope);
    return structuredClone(envelope);
  }

  private retain(envelope: TranscriptEnvelope<TranscriptEvent>): void {
    const bytes = byteSize(envelope);
    if (bytes > this.replayByteCapacity) {
      this.replay.length = 0;
      this.replayBytes = 0;
      return;
    }
    this.replay.push({ envelope, bytes });
    this.replayBytes += bytes;
    while (this.replay.length > this.replayCapacity || this.replayBytes > this.replayByteCapacity) {
      this.replayBytes -= this.replay.shift()!.bytes;
    }
  }

  private cursor(): TranscriptCursor {
    return { streamId: this.streamId, sequence: this.sequence };
  }

  private snapshotDecision(): ReplayDecision<TranscriptEvent, TranscriptState> {
    const snapshot = this.snapshot();
    return { type: 'snapshot', ...snapshot };
  }

  private normalize(event: AgentSessionEvent): TranscriptEvent {
    if (event.type === 'message_start') {
      const startSequence = this.sequence + 1;
      const lifecycleId = `${this.streamId}:${startSequence}`;
      this.startSequences.push(startSequence);
      return { type: 'message_started', lifecycleId, startSequence, message: event.message };
    }

    if (event.type === 'message_update') {
      return { type: 'message_delta', lifecycleId: this.currentLifecycleId(), update: normalizeUpdate(event) };
    }

    if (event.type === 'message_end') {
      const lifecycleId = this.currentLifecycleId();
      this.startSequences.shift();
      return { type: 'message_ended', lifecycleId, message: event.message };
    }

    if (event.type === 'entry_appended') return { type: 'entry_appended', entry: event.entry };
    return { type: 'pi_event', event };
  }

  private currentLifecycleId(): string {
    const startSequence = this.startSequences[0];
    if (startSequence === undefined) throw new Error('Received an assistant message event before message_start');
    return `${this.streamId}:${startSequence}`;
  }
}

function normalizeUpdate(event: Extract<AgentSessionEvent, { type: 'message_update' }>): TranscriptAssistantUpdate {
  const sdkEvent = event.assistantMessageEvent;
  if (!('partial' in sdkEvent)) return { event: sdkEvent };
  const { partial, ...update } = sdkEvent;
  // Only toolcall_start needs its block identity. Delta events already carry
  // their incremental content; retaining partial here stores the growing block
  // again on every token and makes replay traffic quadratic in message size.
  return {
    event: update,
    ...(sdkEvent.type === 'toolcall_start' ? { content: partial.content[sdkEvent.contentIndex] } : {}),
  };
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function projectEntries(entries: SessionEntry[]): TranscriptEntryProjection[] {
  // Pi persists expanded skills/templates as the user message. Replace them with the
  // original invocation so the live snapshot matches paged history. Prompt templates
  // have no <skill> wrapper, so only the display metadata can recover them.
  const replacements = collectDisplayPrompts(entries);
  const projected: TranscriptEntryProjection[] = [];
  for (const entry of buildContextEntries(entries)) {
    // Pi 0.86+ persists the system prompt and tool loadout as system messages so they
    // survive resume and branch navigation. They are model context, never chat, so the
    // display projection drops them (the paged-history path already does).
    const messages = sessionEntryToContextMessages(entry)
      .filter((message) => message.role !== 'system')
      .map((message) => {
        if (message.role !== 'user') return message;
        const text = userMessageText(message.content);
        if (!text) return message;
        const displayText = originalPromptText(text, replacements);
        return displayText === text ? message : { ...message, content: displayText };
      });
    if (messages.length === 0) continue;
    projected.push({
      entryId: entry.id,
      entry: structuredClone(entry),
      messages: structuredClone(messages),
    });
  }
  return projected;
}

function userMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => isTextBlock(block) ? block.text : '')
    .join('');
  return text || undefined;
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string';
}

export function displayedMessages(state: TranscriptState): AgentMessage[] {
  return [...state.baseline.flatMap((entry) => entry.messages), ...state.overlay.map((message) => message.message)];
}
