// Content blocks inside assistant messages
export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ThinkingBlock = { type: 'thinking'; thinking: string };
export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

// Tool result inside user messages
export type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: Array<{ type: 'text'; text: string }>;
};

// Main message types
export type SystemInitMessage = {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  tools: string[];
  cwd: string;
  uuid: string;
};

export type AssistantMessage = {
  type: 'assistant';
  uuid: string;
  session_id: string;
  message: {
    model: string;
    role: 'assistant';
    content: ContentBlock[];
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
};

export type UserMessage = {
  type: 'user';
  uuid?: string;
  session_id: string;
  message: {
    role: 'user';
    content: ToolResultBlock[] | string;
  };
};

export type ResultMessage = {
  type: 'result';
  subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd';
  uuid: string;
  session_id: string;
  result?: string;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  usage: { input_tokens: number; output_tokens: number };
};

export type StreamEvent = {
  type: 'stream_event';
  uuid: string;
  session_id: string;
  event: {
    type: string;
    index?: number;
    delta?: { type: string; text?: string; partial_json?: string };
    content_block?: { type: string; id?: string; name?: string; text?: string };
  };
};

export type ToolProgressMessage = {
  type: 'tool_progress';
  tool_use_id: string;
  tool_name: string;
  elapsed_time_seconds: number;
  uuid: string;
  session_id: string;
};

export type StatusMessage = {
  type: 'system';
  subtype: 'status';
  status: string | null;
  uuid: string;
  session_id: string;
};

// Union of all message types we care about
export type ClaudeMessage =
  | SystemInitMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage
  | StreamEvent
  | ToolProgressMessage
  | StatusMessage;

// Session status
export type SessionStatus = 'starting' | 'running' | 'completed' | 'errored';
