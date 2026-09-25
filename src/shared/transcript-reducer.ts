import { parseStreamingJson, type AssistantMessage } from '@earendil-works/pi-ai';
import type {
  TranscriptAssistantUpdate,
  TranscriptCursor,
  TranscriptEnvelope,
  TranscriptEvent,
  TranscriptReplicaResult,
  TranscriptState,
  TranscriptStreamSwitch,
} from './transcript-sync';
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
    // Pi 0.86+ emits the persisted system prompt/tool loadout as a system message at
    // the start of a run. It is model context, not chat, so it never enters the display.
    if (event.message.role === 'system') return state;
    return {
      ...state,
      overlay: [
        ...state.overlay,
        {
          lifecycleId: event.lifecycleId,
          startSequence: event.startSequence,
          message: event.message,
          toolInput: {},
        },
      ],
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
  // These are current activity indicators, not another transcript/event log.
  // The replay ring owns ordered event retention.
  const events = state.events.filter((item) => item.type !== event.event.type);
  return { ...state, events: [...events, event.event] };
}

/** Applies ordered envelopes. A gap requires an owner snapshot; it is never guessed. */
export class TranscriptReplica {
  private cursor: TranscriptCursor | undefined;
  private state: TranscriptState = { baseline: [], baselineThrough: 0, overlay: [], events: [] };

  applySnapshot(
    cursor: TranscriptCursor,
    state: TranscriptState,
    streamSwitch?: TranscriptStreamSwitch,
  ): TranscriptReplicaResult {
    if (state.baselineThrough > cursor.sequence) return { type: 'snapshot_required' };
    if (!this.cursor || this.cursor.streamId === cursor.streamId) {
      if (this.cursor && this.cursor.sequence > cursor.sequence) return { type: 'duplicate' };
      this.cursor = structuredClone(cursor);
      this.state = structuredClone(state);
      return { type: 'accepted' };
    }
    if (
      !streamSwitch ||
      streamSwitch.fromStreamId !== this.cursor.streamId ||
      streamSwitch.toStreamId !== cursor.streamId
    ) {
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

  trimVisible(): void {
    const overflow = Math.max(0, this.state.overlay.length - 120);
    if (overflow > 0) this.state = { ...this.state, overlay: this.state.overlay.slice(overflow) };
    if (this.state.baseline.length > 120) this.state = { ...this.state, baseline: this.state.baseline.slice(-120) };
  }

  snapshot(): { cursor: TranscriptCursor | undefined; state: TranscriptState } {
    return structuredClone({ cursor: this.cursor, state: this.state });
  }
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
