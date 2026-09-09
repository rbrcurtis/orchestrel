import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { parseStreamingJson, type AssistantMessage } from '@earendil-works/pi-ai';
import { buildContextEntries, sessionEntryToContextMessages, type AgentSessionEvent, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type {
  ReplayDecision,
  TranscriptAssistantUpdate,
  TranscriptCursor,
  TranscriptEntryProjection,
  TranscriptEnvelope,
  TranscriptEvent,
  TranscriptReplicaResult,
  TranscriptState,
  TranscriptStreamSwitch,
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
    return this.sequenceEvent({ type: 'baseline_replaced', entries: projectEntries(entries), coveredThrough: this.sequence });
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

/** Applies one normalized event to a copied display state for replay recipients. */
export function reduceTranscriptState(state: TranscriptState, event: TranscriptEvent): TranscriptState {
  if (event.type === 'baseline_replaced') {
    return {
      baseline: event.entries,
      baselineThrough: event.coveredThrough,
      overlay: state.overlay.filter((message) => message.startSequence > event.coveredThrough),
      events: [],
    };
  }

  if (event.type === 'message_started') {
    return {
      ...state,
      overlay: [...state.overlay, {
        lifecycleId: event.lifecycleId,
        startSequence: event.startSequence,
        message: event.message,
        toolInput: {},
      }],
    };
  }

  if (event.type === 'message_delta' || event.type === 'message_ended') {
    const index = state.overlay.findIndex((message) => message.lifecycleId === event.lifecycleId);
    if (index < 0) return state;
    const overlay = state.overlay.slice();
    const current = overlay[index];
    if (event.type === 'message_ended') {
      overlay[index] = { ...current, message: event.message, toolInput: {} };
    } else if (current.message.role === 'assistant') {
      // Copy only the changing message. Completed history must not be cloned
      // for each streamed token, and earlier snapshots must remain immutable.
      const message = structuredClone(current.message);
      const toolInput = structuredClone(current.toolInput);
      applyAssistantUpdate(message, toolInput, event.update);
      overlay[index] = { ...current, message, toolInput };
    }
    return { ...state, overlay };
  }

  if (event.type === 'entry_appended') return state;
  return { ...state, events: [...state.events, event.event] };
}

/** Applies ordered envelopes. A gap requires an owner snapshot; it is never guessed. */
export class TranscriptReplica {
  private cursor: TranscriptCursor | undefined;
  private state: TranscriptState = { baseline: [], baselineThrough: 0, overlay: [], events: [] };

  applySnapshot(cursor: TranscriptCursor, state: TranscriptState, streamSwitch?: TranscriptStreamSwitch): TranscriptReplicaResult {
    if (state.baselineThrough > cursor.sequence) return { type: 'snapshot_required' };
    if (!this.cursor || this.cursor.streamId === cursor.streamId) {
      if (this.cursor && this.cursor.sequence > cursor.sequence) return { type: 'duplicate' };
      this.cursor = structuredClone(cursor);
      this.state = structuredClone(state);
      return { type: 'accepted' };
    }
    if (!streamSwitch || streamSwitch.fromStreamId !== this.cursor.streamId || streamSwitch.toStreamId !== cursor.streamId) {
      return { type: 'snapshot_required' };
    }
    this.cursor = structuredClone(cursor);
    this.state = structuredClone(state);
    return { type: 'accepted' };
  }

  accept(envelope: TranscriptEnvelope<TranscriptEvent>): TranscriptReplicaResult {
    if (!this.cursor || this.cursor.streamId !== envelope.cursor.streamId) return { type: 'snapshot_required' };
    if (envelope.cursor.sequence <= this.cursor.sequence) return { type: 'duplicate' };
    if (envelope.cursor.sequence !== this.cursor.sequence + 1) return { type: 'snapshot_required' };
    if (envelope.event.type === 'baseline_replaced' && envelope.event.coveredThrough > this.cursor.sequence) {
      return { type: 'snapshot_required' };
    }
    this.state = reduceTranscriptState(this.state, envelope.event);
    this.cursor = structuredClone(envelope.cursor);
    return { type: 'accepted' };
  }

  snapshot(): { cursor: TranscriptCursor | undefined; state: TranscriptState } {
    return structuredClone({ cursor: this.cursor, state: this.state });
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

function applyAssistantUpdate(
  message: AssistantMessage,
  toolInput: Record<number, { raw: string; parsed: Record<string, unknown> }>,
  update: TranscriptAssistantUpdate,
): void {
  const event = update.event;
  if (!('contentIndex' in event)) return;
  const index = event.contentIndex;
  if (event.type === 'text_start') message.content[index] = { type: 'text', text: '' };
  if (event.type === 'text_delta') {
    const block = message.content[index];
    if (block?.type === 'text') block.text += event.delta;
  }
  if (event.type === 'text_end') message.content[index] = { type: 'text', text: event.content };
  if (event.type === 'thinking_start') message.content[index] = { type: 'thinking', thinking: '' };
  if (event.type === 'thinking_delta') {
    const block = message.content[index];
    if (block?.type === 'thinking') block.thinking += event.delta;
  }
  if (event.type === 'thinking_end') message.content[index] = { type: 'thinking', thinking: event.content };
  if (event.type === 'toolcall_start' && update.content?.type === 'toolCall') {
    message.content[index] = structuredClone(update.content);
    toolInput[index] = { raw: '', parsed: {} };
  }
  if (event.type === 'toolcall_delta') {
    // Pi emits incremental JSON chunks. `partial` retains an empty arguments object
    // until toolcall_end, so only the normalized delta stream can reconstruct input.
    const raw = `${toolInput[index]?.raw ?? ''}${event.delta}`;
    toolInput[index] = { raw, parsed: parseStreamingJson(raw) };
  }
  if (event.type === 'toolcall_end') {
    message.content[index] = structuredClone(event.toolCall);
    delete toolInput[index];
  }
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function projectEntries(entries: SessionEntry[]): TranscriptEntryProjection[] {
  return buildContextEntries(entries).map((entry) => ({
    entryId: entry.id,
    entry: structuredClone(entry),
    messages: structuredClone(sessionEntryToContextMessages(entry)),
  }));
}

export function displayedMessages(state: TranscriptState): AgentMessage[] {
  return [...state.baseline.flatMap((entry) => entry.messages), ...state.overlay.map((message) => message.message)];
}
