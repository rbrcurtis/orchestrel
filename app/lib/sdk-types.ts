/** Frontend mirror of SDK message types. No SDK dependency — these are the shapes we receive over WS. */

// Content blocks (inside stream_event deltas)

export interface TextDelta { type: 'text_delta'; text: string }
export interface ThinkingDelta { type: 'thinking_delta'; thinking: string }
export interface InputJsonDelta { type: 'input_json_delta'; partial_json: string }

export interface ContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: { type: 'text' | 'thinking' | 'tool_use'; id?: string; name?: string; text?: string; thinking?: string };
}
export interface ContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: TextDelta | ThinkingDelta | InputJsonDelta;
}
export interface ContentBlockStop { type: 'content_block_stop'; index: number }
export interface MessageStart { type: 'message_start'; message: { id: string; role: string; model: string } }
export interface MessageDelta { type: 'message_delta'; delta: { stop_reason?: string }; usage?: { output_tokens: number } }
export interface MessageStop { type: 'message_stop' }

export type StreamEvent =
  | ContentBlockStart
  | ContentBlockDelta
  | ContentBlockStop
  | MessageStart
  | MessageDelta
  | MessageStop;

// Top-level SDK message types

export interface SdkSystemMessage {
  type: 'system';
  subtype: 'init' | 'compact_boundary';
  session_id?: string;
}

export interface SdkStreamEvent {
  type: 'stream_event';
  event: StreamEvent;
}

export interface SdkAssistantMessage {
  type: 'assistant';
  content: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
  model?: string;
  stop_reason?: string;
}

export interface SdkResultMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd';
  result?: string;
  total_cost_usd: number;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  num_turns: number;
  duration_ms: number;
  model_usage?: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }>;
}

export interface SdkToolProgress {
  type: 'tool_progress';
  tool_name: string;
  data: string;
}

export interface SdkToolUseSummary {
  type: 'tool_use_summary';
  tool_name: string;
  tool_input: unknown;
  tool_result: string;
  is_error?: boolean;
}

export interface SdkTaskStarted {
  type: 'task_started';
  task_id: string;
  description: string;
}

export interface SdkTaskProgress {
  type: 'task_progress';
  task_id: string;
  data: string;
}

export interface SdkTaskNotification {
  type: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed';
  result?: string;
}

export interface SdkRateLimit {
  type: 'rate_limit';
  retry_after_ms: number;
}

export interface SdkStatus {
  type: 'status';
  status: string;
}

export interface SdkError {
  type: 'error';
  message: string;
  timestamp?: number;
}

export type SdkMessage =
  | SdkSystemMessage
  | SdkStreamEvent
  | SdkAssistantMessage
  | SdkResultMessage
  | SdkToolProgress
  | SdkToolUseSummary
  | SdkTaskStarted
  | SdkTaskProgress
  | SdkTaskNotification
  | SdkRateLimit
  | SdkStatus
  | SdkError;
