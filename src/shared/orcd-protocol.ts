// ── Client → orcd ────────────────────────────────────────────────────────────

export interface CreateAction {
  action: 'create';
  prompt: string;
  cwd: string;
  provider: string;
  model: string;
  effort?: string;       // 'high' | 'medium' | 'low' | 'disabled'
  sessionId?: string;    // Resume existing session
  env?: Record<string, string>;  // ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY
  contextWindow?: number;
  summarizeThreshold?: number;  // 0-1, fraction of context window to trigger compaction
}

export interface MessageAction {
  action: 'message';
  sessionId: string;
  prompt: string;
}

export interface SetEffortAction {
  action: 'set_effort';
  sessionId: string;
  effort: string;
}

export interface SubscribeAction {
  action: 'subscribe';
  sessionId: string;
  afterEventIndex?: number;
}

export interface UnsubscribeAction {
  action: 'unsubscribe';
  sessionId: string;
}

export interface ListAction {
  action: 'list';
}

export interface CancelAction {
  action: 'cancel';
  sessionId: string;
}

export interface MemoryUpsertAction {
  action: 'memory_upsert';
  sessionId: string;
}

export interface CompactAction {
  action: 'compact';
  sessionId: string;
  cwd: string;
  provider: string;
  model: string;
  contextWindow?: number;
  summarizeThreshold?: number;
}

export type OrcdAction =
  | CreateAction
  | MessageAction
  | SetEffortAction
  | SubscribeAction
  | UnsubscribeAction
  | ListAction
  | CancelAction
  | MemoryUpsertAction
  | CompactAction;

// ── orcd → Client ────────────────────────────────────────────────────────────

export interface SessionCreatedMessage {
  type: 'session_created';
  sessionId: string;
}

export interface StreamEventMessage {
  type: 'stream_event';
  sessionId: string;
  eventIndex: number;
  event: unknown;        // SDKMessage from Agent SDK
}

export interface SessionResultMessage {
  type: 'result';
  sessionId: string;
  eventIndex: number;
  result: unknown;       // SDKResultMessage from Agent SDK
}

export interface SessionErrorMessage {
  type: 'error';
  sessionId: string;
  error: string;
}

export interface SessionExitMessage {
  type: 'session_exit';
  sessionId: string;
  state: 'completed' | 'errored' | 'stopped';
}

export interface ContextUsageMessage {
  type: 'context_usage';
  sessionId: string;
  contextTokens: number;
  contextWindow: number;
}

export interface SessionIdUpdateMessage {
  type: 'session_id_update';
  sessionId: string;       // orcd-level session id (unchanged, for routing)
  newSessionId: string;    // CC's new session_id after a fork
}

export interface SessionListMessage {
  type: 'session_list';
  sessions: Array<{
    id: string;
    state: 'running' | 'completed' | 'errored' | 'stopped';
    cwd: string;
  }>;
}

export type OrcdMessage =
  | SessionCreatedMessage
  | StreamEventMessage
  | SessionResultMessage
  | SessionErrorMessage
  | SessionExitMessage
  | ContextUsageMessage
  | SessionIdUpdateMessage
  | SessionListMessage;
