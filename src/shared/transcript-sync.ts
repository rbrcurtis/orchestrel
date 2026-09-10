import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AgentSessionEvent, SessionEntry } from '@earendil-works/pi-coding-agent';

export interface TranscriptCursor {
  streamId: string;
  sequence: number;
}

export interface TranscriptIdentity {
  nodeName: string;
  sessionId: string;
}

export interface TranscriptEnvelope<T> {
  cursor: TranscriptCursor;
  event: T;
}

export type ReplayDecision<E, S> =
  | { type: 'replay'; events: TranscriptEnvelope<E>[] }
  | { type: 'snapshot'; cursor: TranscriptCursor; state: S };

export interface TranscriptEntryProjection {
  entryId: string;
  entry: SessionEntry;
  messages: AgentMessage[];
}

export interface TranscriptToolInput {
  raw: string;
  parsed: Record<string, unknown>;
}

export interface TranscriptOverlayMessage {
  lifecycleId: string;
  startSequence: number;
  message: AgentMessage;
  toolInput: Record<number, TranscriptToolInput>;
}

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, 'partial'> : T;

export interface TranscriptAssistantUpdate {
  event: WithoutPartial<AssistantMessageEvent>;
  content?: AssistantMessage['content'][number];
}

export type TranscriptPassthroughEvent = AgentSessionEvent;

/**
 * Normalized SDK events retain roles, tool data, and progress data without storing
 * the SDK's growing partial assistant message on every token delta.
 */
export type TranscriptEvent =
  | { type: 'baseline_replaced'; entries: TranscriptEntryProjection[]; coveredThrough: number }
  | { type: 'message_started'; lifecycleId: string; startSequence: number; message: AgentMessage }
  | { type: 'message_delta'; lifecycleId: string; update: TranscriptAssistantUpdate }
  | { type: 'message_ended'; lifecycleId: string; message: AgentMessage }
  | { type: 'entry_appended'; entry: SessionEntry }
  | { type: 'pi_event'; event: TranscriptPassthroughEvent };

export interface TranscriptState {
  baseline: TranscriptEntryProjection[];
  /** Number of older completed live records held in the owner spool. */
  spooled?: number;
  /** Sequence through which the baseline projection is authoritative. */
  baselineThrough: number;
  overlay: TranscriptOverlayMessage[];
  events: TranscriptPassthroughEvent[];
}

export type TranscriptReplicaResult =
  | { type: 'accepted' }
  | { type: 'duplicate' }
  | { type: 'snapshot_required' };

/** Explicit authorization to replace a replica with a new stream incarnation. */
export interface TranscriptStreamSwitch {
  fromStreamId: string | undefined;
  toStreamId: string;
}
