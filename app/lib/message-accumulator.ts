import { makeAutoObservable, observable } from 'mobx';
import type {
  SdkMessage,
  SdkStreamEvent,
  SdkResultMessage,
  SdkToolUseSummary,
  SdkTaskStarted,
  SdkTaskProgress,
  SdkTaskNotification,
  ContentBlockStart,
  ContentBlockDelta,
  ContentBlockStop,
  HistoryMessage,
  HistoryAssistantContentBlock,
} from './sdk-types';

export class ContentBlock {
  type: 'text' | 'thinking' | 'tool_use';
  content: string;
  id?: string;
  name?: string;
  input?: string;
  complete: boolean;

  constructor(init: { type: 'text' | 'thinking' | 'tool_use'; content: string; id?: string; name?: string; input?: string; complete: boolean }) {
    this.type = init.type;
    this.content = init.content;
    this.id = init.id;
    this.name = init.name;
    this.input = init.input;
    this.complete = init.complete;
    makeAutoObservable(this, { type: false, id: false, name: false });
  }
}

export interface TurnResult {
  subtype: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  numTurns: number;
  durationMs: number;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

export interface ToolActivity {
  name: string;
  input: unknown;
  result: string;
  isError: boolean;
}

export interface SubagentState {
  taskId: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  lastProgress: string;
}

export type ConversationEntry =
  | { kind: 'blocks'; blocks: ContentBlock[]; model?: string }
  | { kind: 'result'; data: TurnResult }
  | { kind: 'tool_activity'; data: ToolActivity }
  | { kind: 'user'; content: string; optimistic?: boolean }
  | { kind: 'system'; subtype: string; model?: string }
  | { kind: 'error'; message: string }
  | { kind: 'compact' };

export class MessageAccumulator {
  conversation: ConversationEntry[] = [];
  currentBlocks: ContentBlock[] = [];
  subagents = new Map<string, SubagentState>();
  retryAfterMs: number | null = null;

  constructor() {
    makeAutoObservable(this, {
      conversation: observable.shallow,
      currentBlocks: observable.shallow,
      subagents: observable,
    });
  }

  handleMessage(msg: SdkMessage): void {
    switch (msg.type) {
      case 'stream_event':
        this.handleStreamEvent(msg);
        break;
      case 'assistant':
        this.finalizeBlocks();
        break;
      case 'result':
        this.handleResult(msg);
        break;
      case 'tool_use_summary':
        this.handleToolUseSummary(msg);
        break;
      case 'task_started':
        this.handleTaskStarted(msg);
        break;
      case 'task_progress':
        this.handleTaskProgress(msg);
        break;
      case 'task_notification':
        this.handleTaskNotification(msg);
        break;
      case 'rate_limit':
        this.retryAfterMs = msg.retry_after_ms;
        break;
      case 'system':
        if (msg.subtype === 'init') {
          this.finalizeBlocks();
          this.conversation.push({ kind: 'system', subtype: 'init', model: msg.model });
        } else if (msg.subtype === 'compact_boundary') {
          this.finalizeBlocks();
          this.conversation.push({ kind: 'compact' });
        }
        break;
      case 'error':
        this.finalizeBlocks();
        this.conversation.push({ kind: 'error', message: msg.message });
        break;
      case 'status':
        if (this.retryAfterMs !== null) this.retryAfterMs = null;
        break;
    }
  }

  addUserMessage(content: string, optimistic = false): void {
    this.finalizeBlocks();
    this.conversation.push({ kind: 'user', content, optimistic });
  }

  handleHistoryMessage(msg: HistoryMessage): void {
    switch (msg.type) {
      case 'user': {
        const { content } = msg.message;
        if (typeof content === 'string') {
          this.conversation.push({ kind: 'user', content });
        } else if (Array.isArray(content)) {
          // Array content: extract text blocks (user prompts), skip tool_result blocks
          const text = content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text?: string }).text ?? '')
            .join('\n');
          if (text) this.conversation.push({ kind: 'user', content: text });
        }
        break;
      }
      case 'assistant': {
        const blocks: ContentBlock[] = msg.message.content
          .filter((b: HistoryAssistantContentBlock) => {
            // SDK session JSONL records tool_use blocks twice: once with input when
            // the model produces them, and again with empty input {} in the continued
            // API response after tool results. Skip the empty duplicates.
            if (b.type === 'tool_use') {
              const inp = b.input as Record<string, unknown> | undefined;
              if (!inp || Object.keys(inp).length === 0) return false;
            }
            return true;
          })
          .map((b: HistoryAssistantContentBlock) => {
            if (b.type === 'tool_use') {
              return new ContentBlock({
                type: 'tool_use',
                content: b.name ?? '',
                id: b.id,
                name: b.name,
                input: b.input !== undefined ? JSON.stringify(b.input) : '',
                complete: true,
              });
            }
            if (b.type === 'thinking') {
              return new ContentBlock({ type: 'thinking', content: b.thinking ?? '', complete: true });
            }
            // text
            return new ContentBlock({ type: 'text', content: b.text ?? '', complete: true });
          });
        if (blocks.length > 0) {
          this.conversation.push({ kind: 'blocks', blocks, model: msg.message.model });
        }
        break;
      }
      case 'system':
        // Skip system messages for now
        break;
    }
  }

  private handleStreamEvent(msg: SdkStreamEvent): void {
    const evt = msg.event;
    switch (evt.type) {
      case 'content_block_start':
        this.onContentBlockStart(evt);
        break;
      case 'content_block_delta':
        this.onContentBlockDelta(evt);
        break;
      case 'content_block_stop':
        this.onContentBlockStop(evt);
        break;
      case 'message_start':
        this.currentBlocks = [];
        break;
      case 'message_stop':
        this.finalizeBlocks();
        break;
    }
  }

  private onContentBlockStart(evt: ContentBlockStart): void {
    const block = new ContentBlock({
      type: evt.content_block.type as 'text' | 'thinking' | 'tool_use',
      content: evt.content_block.text ?? evt.content_block.thinking ?? '',
      id: evt.content_block.id,
      name: evt.content_block.name,
      input: '',
      complete: false,
    });
    this.currentBlocks.push(block);
  }

  private onContentBlockDelta(evt: ContentBlockDelta): void {
    const block = this.currentBlocks[evt.index];
    if (!block) return;
    switch (evt.delta.type) {
      case 'text_delta':
        block.content += evt.delta.text;
        break;
      case 'thinking_delta':
        block.content += evt.delta.thinking;
        break;
      case 'input_json_delta':
        block.input = (block.input ?? '') + evt.delta.partial_json;
        break;
    }
  }

  private onContentBlockStop(evt: ContentBlockStop): void {
    const block = this.currentBlocks[evt.index];
    if (block) block.complete = true;
  }

  private finalizeBlocks(): void {
    if (this.currentBlocks.length > 0) {
      for (const b of this.currentBlocks) b.complete = true;
      this.conversation.push({ kind: 'blocks', blocks: [...this.currentBlocks] });
      this.currentBlocks = [];
    }
  }

  private handleResult(msg: SdkResultMessage): void {
    this.finalizeBlocks();
    this.retryAfterMs = null;
    this.conversation.push({
      kind: 'result',
      data: {
        subtype: msg.subtype,
        costUsd: msg.total_cost_usd,
        inputTokens: msg.usage?.input_tokens ?? 0,
        outputTokens: msg.usage?.output_tokens ?? 0,
        cacheRead: msg.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage?.cache_creation_input_tokens ?? 0,
        numTurns: msg.num_turns,
        durationMs: msg.duration_ms,
        modelUsage: msg.model_usage
          ? Object.fromEntries(
              Object.entries(msg.model_usage).map(([k, v]) => [
                k,
                { inputTokens: v?.input_tokens ?? 0, outputTokens: v?.output_tokens ?? 0, costUsd: v?.cost_usd ?? 0 },
              ]),
            )
          : undefined,
      },
    });
  }

  private handleToolUseSummary(msg: SdkToolUseSummary): void {
    this.conversation.push({
      kind: 'tool_activity',
      data: {
        name: msg.tool_name,
        input: msg.tool_input,
        result: msg.tool_result,
        isError: msg.is_error ?? false,
      },
    });
  }

  private handleTaskStarted(msg: SdkTaskStarted): void {
    this.subagents.set(msg.task_id, {
      taskId: msg.task_id,
      description: msg.description,
      status: 'running',
      lastProgress: '',
    });
  }

  private handleTaskProgress(msg: SdkTaskProgress): void {
    const sub = this.subagents.get(msg.task_id);
    if (sub) sub.lastProgress = msg.data;
  }

  private handleTaskNotification(msg: SdkTaskNotification): void {
    const sub = this.subagents.get(msg.task_id);
    if (sub) {
      sub.status = msg.status;
      setTimeout(() => this.subagents.delete(msg.task_id), 2000);
    }
  }

  clear(): void {
    this.conversation = [];
    this.currentBlocks = [];
    this.subagents.clear();
    this.retryAfterMs = null;
  }
}
