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
  subtype: 'init' | 'compact_boundary' | 'bgc_started';
  session_id?: string;
  model?: string;
  source?: string;
  timestamp?: number;
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

export interface SdkUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{
      type: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
}

export interface SdkResultMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  result?: string;
  total_cost_usd: number;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  num_turns: number;
  duration_ms: number;
  duration_api_ms?: number;
  timestamp?: number;
  modelUsage?: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }>;
  // Keep model_usage as alias for backwards compat with existing history
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
  tool_use_id?: string;
  is_error?: boolean;
  timestamp?: number;
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
  | SdkUserMessage
  | SdkResultMessage
  | SdkToolProgress
  | SdkToolUseSummary
  | SdkTaskStarted
  | SdkTaskProgress
  | SdkTaskNotification
  | SdkRateLimit
  | SdkStatus
  | SdkError;

// SessionMessage format returned by getSessionMessages()

type HistoryTimestamp = number | string;

export interface HistoryUserMessage {
  type: 'user';
  uuid: string;
  session_id: string;
  parent_tool_use_id: null;
  timestamp?: HistoryTimestamp;
  message: { role: 'user'; content: string | Array<{ type: string; [key: string]: unknown }> };
}

export interface HistoryAssistantContentBlock {
  type: 'text' | 'thinking' | 'tool_use';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  caller?: unknown;
}

export interface HistoryAssistantMessage {
  type: 'assistant';
  uuid: string;
  session_id: string;
  parent_tool_use_id: null;
  timestamp?: HistoryTimestamp;
  message: {
    role: 'assistant';
    model: string;
    content: HistoryAssistantContentBlock[];
    stop_reason?: string;
    usage?: unknown;
  };
}

export interface HistorySystemMessage {
  type: 'system';
  uuid: string;
  session_id: string;
  parent_tool_use_id: null;
  subtype?: 'init' | 'compact_boundary' | string;
  model?: string;
  source?: string;
  timestamp?: HistoryTimestamp;
  message?: unknown;
}

export type HistoryMessage = HistoryUserMessage | HistoryAssistantMessage | HistorySystemMessage;
