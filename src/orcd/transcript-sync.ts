import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { buildContextEntries, sessionEntryToContextMessages, type AgentSessionEvent, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type {
  ReplayDecision,
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
  private readonly replay: TranscriptEnvelope<TranscriptEvent>[] = [];
  private readonly startSequences: number[] = [];
  private state: TranscriptState;

  constructor(
    readonly streamId: string,
    initialEntries: SessionEntry[],
    private readonly replayCapacity: number,
  ) {
    if (replayCapacity < 1) throw new Error('Transcript replay capacity must be positive');
    this.state = { baseline: projectEntries(initialEntries), overlay: [], events: [] };
  }

  accept(event: AgentSessionEvent): TranscriptEnvelope<TranscriptEvent> {
    const normalized = this.normalize(event);
    const envelope = {
      cursor: { streamId: this.streamId, sequence: ++this.sequence },
      event: structuredClone(normalized),
    };
    this.state = reduceTranscriptState(this.state, envelope.event);
    this.replay.push(envelope);
    if (this.replay.length > this.replayCapacity) this.replay.shift();
    return structuredClone(envelope);
  }

  settle(entries: SessionEntry[]): TranscriptEnvelope<TranscriptEvent> {
    const projection = projectEntries(entries);
    const coveredThrough = this.sequence;
    const envelope = {
      cursor: { streamId: this.streamId, sequence: ++this.sequence },
      event: { type: 'baseline_replaced' as const, entries: projection, coveredThrough },
    };
    this.state = reduceTranscriptState(this.state, envelope.event);
    this.replay.push(envelope);
    if (this.replay.length > this.replayCapacity) this.replay.shift();
    return structuredClone(envelope);
  }

  snapshot(): { cursor: TranscriptCursor; state: TranscriptState } {
    return structuredClone({ cursor: this.cursor(), state: this.state });
  }

  replaySince(cursor: TranscriptCursor | undefined): ReplayDecision<TranscriptEvent, TranscriptState> {
    if (!cursor || cursor.streamId !== this.streamId || cursor.sequence > this.sequence) return this.snapshotDecision();
    if (cursor.sequence === this.sequence) return { type: 'replay', events: [] };
    const oldest = this.replay[0];
    if (!oldest || cursor.sequence < oldest.cursor.sequence - 1) return this.snapshotDecision();
    return { type: 'replay', events: structuredClone(this.replay.filter((event) => event.cursor.sequence > cursor.sequence)) };
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
      const lifecycleId = this.currentLifecycleId();
      return { type: 'message_delta', lifecycleId, update: withoutPartial(event.assistantMessageEvent) }; 
    }

    if (event.type === 'message_end') {
      const lifecycleId = this.currentLifecycleId();
      this.startSequences.shift();
      return { type: 'message_ended', lifecycleId, message: event.message };
    }

    if (event.type === 'entry_appended') return { type: 'entry_appended', entry: event.entry };
    if (event.type === 'agent_settled') return { type: 'pi_event', event };
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
  const next = structuredClone(state);
  if (event.type === 'baseline_replaced') {
    next.baseline = event.entries;
    next.overlay = next.overlay.filter((message) => message.startSequence > event.coveredThrough);
    return next;
  }

  if (event.type === 'message_started') {
    next.overlay.push({ lifecycleId: event.lifecycleId, startSequence: event.startSequence, message: event.message });
    return next;
  }

  if (event.type === 'message_delta') return next;

  if (event.type === 'message_ended') {
    const overlay = next.overlay.find((message) => message.lifecycleId === event.lifecycleId);
    if (overlay) overlay.message = event.message;
    return next;
  }

  if (event.type === 'entry_appended') return next;
  next.events.push(event.event);
  return next;
}

/** Applies ordered envelopes and ignores duplicate or stale deliveries. */
export class TranscriptReplica {
  private cursor: TranscriptCursor | undefined;
  private state: TranscriptState = { baseline: [], overlay: [], events: [] };

  applySnapshot(cursor: TranscriptCursor, state: TranscriptState): void {
    if (this.cursor && (this.cursor.streamId !== cursor.streamId || this.cursor.sequence > cursor.sequence)) return;
    this.cursor = structuredClone(cursor);
    this.state = structuredClone(state);
  }

  accept(envelope: TranscriptEnvelope<TranscriptEvent>): void {
    if (!this.cursor || this.cursor.streamId !== envelope.cursor.streamId) return;
    if (envelope.cursor.sequence <= this.cursor.sequence) return;
    this.state = reduceTranscriptState(this.state, envelope.event);
    this.cursor = structuredClone(envelope.cursor);
  }

  snapshot(): { cursor: TranscriptCursor | undefined; state: TranscriptState } {
    return structuredClone({ cursor: this.cursor, state: this.state });
  }
}

function withoutPartial(event: Extract<AgentSessionEvent, { type: 'message_update' }>['assistantMessageEvent']): TranscriptEvent extends { type: 'message_delta'; update: infer T } ? T : never {
  if ('partial' in event) {
    const { partial: _, ...update } = event;
    return update as TranscriptEvent extends { type: 'message_delta'; update: infer T } ? T : never;
  }
  return event as TranscriptEvent extends { type: 'message_delta'; update: infer T } ? T : never;
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
