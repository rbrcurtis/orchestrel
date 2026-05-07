import { makeAutoObservable, observable } from 'mobx';
import type {
  SdkMessage,
  SdkStreamEvent,
  SdkResultMessage,
  SdkToolUseSummary,
  SdkUserMessage,
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
  | { kind: 'blocks'; blocks: ContentBlock[]; model?: string; timestamp?: number }
  | { kind: 'result'; data: TurnResult; timestamp?: number }
  | { kind: 'tool_activity'; data: ToolActivity; timestamp?: number }
  | { kind: 'user'; content: string; optimistic?: boolean; timestamp?: number }
  | { kind: 'system'; subtype: string; model?: string; timestamp?: number }
  | { kind: 'error'; message: string; timestamp?: number }
  | { kind: 'compact'; label?: string; timestamp?: number };

function normalizeTimestamp(timestamp: number | string | undefined): number | undefined {
  if (timestamp == null) return undefined;
  if (typeof timestamp === 'number') return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseToolInput(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function summarizeToolResult(result: string): string {
  const line = result.trim().split('\n').find(Boolean) ?? 'Done';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export class MessageAccumulator {
  conversation: ConversationEntry[] = [];
  currentBlocks: ContentBlock[] = [];
  subagents = new Map<string, SubagentState>();
  retryAfterMs: number | null = null;
  private historyPendingResultTimestamp?: number;
  private historyTurnCount = 0;
  private blockingSubagentToolIds = new Map<string, string>();

  addCompactMarker(label: string, timestamp = Date.now()): void {
    this.finalizeBlocks();
    this.conversation.push({ kind: 'compact', label, timestamp });
  }


  constructor() {
    makeAutoObservable<this, 'historyPendingResultTimestamp' | 'historyTurnCount' | 'blockingSubagentToolIds'>(this, {
      conversation: observable.shallow,
      currentBlocks: observable.shallow,
      subagents: observable,
      historyPendingResultTimestamp: false,
      historyTurnCount: false,
      blockingSubagentToolIds: false,
    });
  }

  handleMessage(msg: SdkMessage): void {
    switch (msg.type) {
      case 'stream_event':
        this.handleStreamEvent(msg);
        break;
      case 'assistant':
        break;
      case 'user':
        this.handleUserMessage(msg);
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
          this.conversation.push({ kind: 'system', subtype: 'init', model: msg.model, timestamp: msg.timestamp ?? Date.now() });
        } else if (msg.subtype === 'compact_boundary') {
          this.finalizeBlocks();
          const label = msg.source === 'orchestrel-bgc' ? 'Background compaction applied' : undefined;
          this.conversation.push({ kind: 'compact', label, timestamp: msg.timestamp });
        } else if (msg.subtype === 'bgc_started') {
          this.finalizeBlocks();
          this.conversation.push({ kind: 'compact', label: 'Background compaction started', timestamp: msg.timestamp });
        }
        break;
      case 'error':
        this.finalizeBlocks();
        this.conversation.push({ kind: 'error', message: msg.message, timestamp: msg.timestamp });
        break;
      case 'status':
        if (this.retryAfterMs !== null) this.retryAfterMs = null;
        break;
    }
  }

  addUserMessage(content: string, optimistic = false): void {
    this.finalizeBlocks();
    this.conversation.push({ kind: 'user', content, optimistic, timestamp: optimistic ? Date.now() : undefined });
  }

  handleHistoryMessage(msg: HistoryMessage): void {
    switch (msg.type) {
      case 'user': {
        const timestamp = normalizeTimestamp(msg.timestamp);
        const { content } = msg.message;
        if (typeof content === 'string') {
          this.finalizePendingHistoryTurn(timestamp);
          this.conversation.push({ kind: 'user', content, timestamp });
        } else if (Array.isArray(content)) {
          // Array content may be a real prompt with text blocks, or an internal
          // tool_result message persisted with role=user. Only treat text-bearing
          // entries as true user turn boundaries.
          const text = content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text?: string }).text ?? '')
            .join('\n');
          if (text) {
            this.finalizePendingHistoryTurn(timestamp);
            this.conversation.push({ kind: 'user', content: text, timestamp });
          }
        }
        break;
      }
      case 'assistant': {
        const assistantTimestamp = normalizeTimestamp(msg.timestamp);
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
          this.backfillHistoryInitModel(msg.message.model);
          this.conversation.push({ kind: 'blocks', blocks, model: msg.message.model, timestamp: assistantTimestamp });
          this.historyPendingResultTimestamp = assistantTimestamp;
        }
        break;
      }
      case 'system':
        if (msg.subtype === 'init') {
          this.finalizePendingHistoryTurn(normalizeTimestamp(msg.timestamp));
          this.conversation.push({ kind: 'system', subtype: 'init', model: msg.model, timestamp: normalizeTimestamp(msg.timestamp) });
        } else if (msg.subtype === 'compact_boundary') {
          const timestamp = normalizeTimestamp(msg.timestamp);
          this.finalizePendingHistoryTurn(timestamp);
          const label = msg.source === 'orchestrel-bgc' ? 'Background compaction applied' : undefined;
          this.conversation.push({ kind: 'compact', label, timestamp });
        } else if (msg.subtype === 'bgc_started') {
          this.finalizePendingHistoryTurn(normalizeTimestamp(msg.timestamp));
          this.conversation.push({ kind: 'compact', label: 'Background compaction started', timestamp: normalizeTimestamp(msg.timestamp) });
        }
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
    if (!block) return;

    block.complete = true;
    this.trackBlockingSubagent(block);
  }

  private trackBlockingSubagent(block: ContentBlock): void {
    if (block.type !== 'tool_use') return;
    if (block.name !== 'Agent' && block.name !== 'Task') return;
    if (!block.id) return;

    const input = parseToolInput(block.input);
    if (input.run_in_background === true) return;

    const description = typeof input.description === 'string' && input.description.trim()
      ? input.description.trim()
      : 'Subagent';
    this.blockingSubagentToolIds.set(block.id, description);
    this.subagents.set(block.id, {
      taskId: block.id,
      description,
      status: 'running',
      lastProgress: 'Running',
    });
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
      timestamp: msg.timestamp ?? Date.now(),
      data: {
        subtype: msg.subtype,
        costUsd: msg.total_cost_usd,
        inputTokens: msg.usage?.input_tokens ?? 0,
        outputTokens: msg.usage?.output_tokens ?? 0,
        cacheRead: msg.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage?.cache_creation_input_tokens ?? 0,
        numTurns: msg.num_turns,
        durationMs: msg.duration_ms,
        modelUsage: (() => {
          const raw = msg.modelUsage ?? msg.model_usage;
          if (!raw) return undefined;
          return Object.fromEntries(
            Object.entries(raw).map(([k, v]) => [
              k,
              { inputTokens: v?.input_tokens ?? 0, outputTokens: v?.output_tokens ?? 0, costUsd: v?.cost_usd ?? 0 },
            ]),
          );
        })(),
      },
    });
  }

  private handleUserMessage(msg: SdkUserMessage): void {
    for (const block of msg.message.content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      this.completeBlockingSubagent(
        block.tool_use_id,
        textFromToolResultContent(block.content),
        block.is_error ?? false,
      );
    }
  }

  private handleToolUseSummary(msg: SdkToolUseSummary): void {
    this.conversation.push({
      kind: 'tool_activity',
      timestamp: msg.timestamp,
      data: {
        name: msg.tool_name,
        input: msg.tool_input,
        result: msg.tool_result,
        isError: msg.is_error ?? false,
      },
    });

    if (msg.tool_use_id) this.completeBlockingSubagent(msg.tool_use_id, msg.tool_result, msg.is_error ?? false);
  }

  private completeBlockingSubagent(toolUseId: string, result: string, isError: boolean): void {
    if (!this.blockingSubagentToolIds.has(toolUseId)) return;

    const sub = this.subagents.get(toolUseId);
    if (!sub) return;

    sub.status = isError ? 'failed' : 'completed';
    sub.lastProgress = summarizeToolResult(result);
    this.blockingSubagentToolIds.delete(toolUseId);
    setTimeout(() => this.subagents.delete(toolUseId), 2000);
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

  flushHistory(): void {
    this.finalizePendingHistoryTurn();
  }

  clearSubagents(): void {
    this.subagents.clear();
    this.blockingSubagentToolIds.clear();
  }

  private finalizePendingHistoryTurn(timestamp = this.historyPendingResultTimestamp): void {
    if (this.historyPendingResultTimestamp == null) return;
    this.historyTurnCount += 1;
    this.conversation.push({
      kind: 'result',
      timestamp,
      data: {
        subtype: 'success',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        numTurns: this.historyTurnCount,
        durationMs: 0,
      },
    });
    this.historyPendingResultTimestamp = undefined;
  }

  private backfillHistoryInitModel(model: string | undefined): void {
    if (!model) return;
    const initEntry = this.conversation.find(
      (entry): entry is Extract<ConversationEntry, { kind: 'system' }> => entry.kind === 'system' && entry.subtype === 'init',
    );
    if (initEntry && !initEntry.model) initEntry.model = model;
  }

  clear(): void {
    this.conversation = [];
    this.currentBlocks = [];
    this.clearSubagents();
    this.retryAfterMs = null;
    this.historyPendingResultTimestamp = undefined;
    this.historyTurnCount = 0;
  }
}
