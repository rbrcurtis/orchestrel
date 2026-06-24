/* oxlint-disable orchestrel/log-before-early-return -- session lifecycle guards intentionally return existing state without noisy per-event logs */
import { randomUUID } from 'crypto';
import { AsyncTaskTracker, extractAsyncAgentLaunches, parseTaskNotification } from './async-task-tracker';
import { getContextUsageFromPiEvent, mapPiEventToOrcdPayload, mapSubagentExecEvent } from './pi-events';
import { createPiRuntimeSession, type PiRuntimeSession } from './pi-runtime';
import { RingBuffer } from './ring-buffer';
import type { ProviderConfig } from './config';
import type { SessionState } from './types';
import type {
  ContextUsageMessage,
  SessionErrorMessage,
  SessionExitMessage,
  SessionIdUpdateMessage,
  SessionResultMessage,
  StreamEventMessage,
  TurnCompleteMessage,
} from '../shared/orcd-protocol';
import type { TaskNotificationEvent, TaskProgressEvent, TaskStartedEvent } from './async-task-tracker';

export type SessionEventCallback = (
  msg: StreamEventMessage | SessionResultMessage | TurnCompleteMessage | SessionErrorMessage | SessionExitMessage | ContextUsageMessage | SessionIdUpdateMessage,
) => void;

export class OrcdSession {
  readonly id: string;
  state: SessionState = 'running';
  readonly cwd: string;
  readonly model: string;
  readonly provider: string;
  readonly contextWindow: number | undefined;
  readonly summarizeThreshold: number;
  readonly providerConfig: ProviderConfig | undefined;
  readonly buffer: RingBuffer<unknown>;

  /** Last known context token count (updated after each result) */
  lastContextTokens = 0;
  lastContextWindow = 0;

  private readonly asyncTasks = new AsyncTaskTracker();
  private readonly agentToolDescriptions = new Map<string, string>();
  private readonly lastSubagentProgress = new Map<string, string>();
  private readonly beforeExitHooks: Array<() => Promise<void>> = [];
  private readonly asyncTaskPollMs: number;

  private piSession: PiRuntimeSession | null = null;
  private running = false;
  private subscribers = new Set<SessionEventCallback>();
  private onFork: ((oldId: string, newId: string) => void) | undefined;
  private forkedTo: string | undefined;

  constructor(opts: {
    cwd: string;
    model: string;
    provider: string;
    bufferSize?: number;
    sessionId?: string;
    contextWindow?: number;
    summarizeThreshold?: number;
    providerConfig?: ProviderConfig;
    onFork?: (oldId: string, newId: string) => void;
    asyncTaskPollMsForTesting?: number;
  }) {
    this.id = opts.sessionId ?? randomUUID();
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.provider = opts.provider;
    this.contextWindow = opts.contextWindow;
    this.summarizeThreshold = opts.summarizeThreshold ?? 0;
    this.providerConfig = opts.providerConfig;
    this.buffer = new RingBuffer(opts.bufferSize ?? 1000);
    this.onFork = opts.onFork;
    this.asyncTaskPollMs = opts.asyncTaskPollMsForTesting ?? 1000;
  }

  onBeforeExit(cb: () => Promise<void>): void {
    this.beforeExitHooks.push(cb);
  }

  private async runBeforeExitHooks(): Promise<void> {
    for (const cb of this.beforeExitHooks) await cb();
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private rememberAgentToolDescriptions(event: unknown): void {
    if (this.isRecord(event) && event.type === 'assistant') {
      const message = event.message;
      if (this.isRecord(message) && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!this.isRecord(block) || block.type !== 'tool_use') continue;

          const toolUseId = block.id;
          if (typeof toolUseId !== 'string') continue;

          const name = block.name;
          const input = block.input;
          if (!this.isRecord(input)) continue;
          const description = input.description;
          if (name !== 'Agent' && name !== 'Task') continue;
          if (typeof description !== 'string' || !description.trim()) continue;

          this.agentToolDescriptions.set(toolUseId, description.trim());
        }
      }
    }
  }

  private emitSyntheticTaskEvent(event: TaskStartedEvent | TaskProgressEvent | TaskNotificationEvent): void {
    const msg: StreamEventMessage = {
      type: 'stream_event',
      sessionId: this.id,
      eventIndex: this.buffer.push(event),
      event,
    };
    for (const cb of this.subscribers) cb(msg);
  }

  private recordAsyncAgentLaunches(event: unknown): void {
    for (const launch of extractAsyncAgentLaunches(event, this.agentToolDescriptions)) {
      const started = this.asyncTasks.recordLaunch(launch);
      if (started) this.emitSyntheticTaskEvent(started);
    }
  }

  private textFromPiEvent(event: unknown): string {
    if (typeof event === 'string') return event;
    if (Array.isArray(event)) return event.map((item) => this.textFromPiEvent(item)).filter(Boolean).join('\n');
    if (!this.isRecord(event)) return '';

    const text = event.text;
    if (typeof text === 'string') return text;

    const content = event.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((item) => this.textFromPiEvent(item)).filter(Boolean).join('\n');

    const message = event.message;
    if (this.isRecord(message) || Array.isArray(message)) return this.textFromPiEvent(message);

    return '';
  }

  /**
   * Turn the pi-subagents extension's `Agent` tool_execution_* events into the
   * subagent line-item lifecycle the UI renders (task_started/progress/notification).
   * Progress frames are deduped on the activity text so spinner-only ticks don't
   * flood the stream.
   */
  private recordPiSubagentEvent(event: unknown): void {
    const taskEvent = mapSubagentExecEvent(event);
    if (!taskEvent) return;

    if (taskEvent.type === 'task_progress') {
      if (this.lastSubagentProgress.get(taskEvent.task_id) === taskEvent.data) return;
      this.lastSubagentProgress.set(taskEvent.task_id, taskEvent.data);
    } else if (taskEvent.type === 'task_notification') {
      this.lastSubagentProgress.delete(taskEvent.task_id);
    }

    this.emitSyntheticTaskEvent(taskEvent);
  }

  private recordAsyncTaskNotification(event: unknown): void {
    const notification = parseTaskNotification(this.textFromPiEvent(event));
    if (!notification) return;

    const taskEvent = this.asyncTasks.recordNotification(notification);
    if (taskEvent) this.emitSyntheticTaskEvent(taskEvent);
  }

  private async waitForAsyncTasks(): Promise<void> {
    while (this.state !== 'stopped' && this.asyncTasks.hasPending()) {
      await new Promise((resolve) => setTimeout(resolve, this.asyncTaskPollMs));
    }
  }

  subscribe(cb: SessionEventCallback): void {
    this.subscribers.add(cb);
  }

  unsubscribe(cb: SessionEventCallback): void {
    this.subscribers.delete(cb);
  }

  /**
   * Replay buffered events to a subscriber (for reconnection).
   */
  replay(afterEventIndex: number | undefined, cb: SessionEventCallback): void {
    const events = this.buffer.since(afterEventIndex ?? -1);
    for (const { index, item } of events) {
      cb({
        type: 'stream_event',
        sessionId: this.id,
        eventIndex: index,
        event: item,
      });
    }
  }

  private async getOrCreatePiSession(effort: string | undefined): Promise<PiRuntimeSession> {
    if (this.piSession) return this.piSession;

    const session = await createPiRuntimeSession({
      cwd: this.cwd,
      providerId: this.provider,
      modelId: this.model,
      sessionId: this.id,
      effort,
      provider: this.providerConfig,
    });
    this.piSession = session;

    if (session.id !== this.id && session.id !== this.forkedTo) {
      this.forkedTo = session.id;
      this.onFork?.(this.id, session.id);
      const upd: SessionIdUpdateMessage = {
        type: 'session_id_update',
        sessionId: this.id,
        newSessionId: session.id,
      };
      for (const cb of this.subscribers) cb(upd);
      console.log(`[orcd:${this.id.slice(0, 8)}] pi session id: ${this.id.slice(0, 8)} → ${session.id.slice(0, 8)}`);
    }

    return session;
  }

  private emitMappedPiEvent(event: unknown): void {
    const usage = getContextUsageFromPiEvent(event);
    const payload = mapPiEventToOrcdPayload(event);
    const eventIndex = this.buffer.push(payload);

    console.log(`[orcd:${this.id.slice(0, 8)}] ${JSON.stringify(payload)}`);
    this.rememberAgentToolDescriptions(payload);
    this.recordAsyncAgentLaunches(payload);
    this.recordAsyncTaskNotification(payload);
    this.recordPiSubagentEvent(event);

    if (this.isRecord(payload) && payload.type === 'result') {
      const msg: SessionResultMessage = {
        type: 'result',
        sessionId: this.id,
        eventIndex,
        result: payload,
      };
      for (const cb of this.subscribers) cb(msg);

      // A result means one agent turn finished. Background tasks (monitors,
      // subagents) may still be running, so this is NOT session_exit — the orc
      // backend uses turn_complete to move the card to review while orcd keeps
      // the session alive until the SDK iterator actually closes.
      const turnMsg: TurnCompleteMessage = {
        type: 'turn_complete',
        sessionId: this.id,
        eventIndex,
        hasPendingAsyncTasks: this.asyncTasks.hasPending(),
      };
      for (const cb of this.subscribers) cb(turnMsg);
    } else {
      const msg: StreamEventMessage = {
        type: 'stream_event',
        sessionId: this.id,
        eventIndex,
        event: payload,
      };
      for (const cb of this.subscribers) cb(msg);
    }

    if (!usage) return;

    this.lastContextTokens = usage.contextTokens;
    this.lastContextWindow = usage.contextWindow;
    const msg: ContextUsageMessage = {
      type: 'context_usage',
      sessionId: this.id,
      contextTokens: usage.contextTokens,
      contextWindow: usage.contextWindow,
    };
    for (const cb of this.subscribers) cb(msg);
  }

  /**
   * Start or resume a session.
   */
  async run(opts: {
    prompt: string;
    resume?: boolean;
    effort?: string;
  }): Promise<void> {
    const log = (msg: string) => console.log(`[orcd:${this.id.slice(0, 8)}] ${msg}`);

    if (this.running) {
      const msg = `session already running; dropping overlapping prompt`;
      log(msg);
      const errMsg: SessionErrorMessage = {
        type: 'error',
        sessionId: this.id,
        error: msg,
      };
      for (const cb of this.subscribers) cb(errMsg);
      return;
    }

    this.running = true;
    let unsubscribe: () => void = () => undefined;
    try {
      const session = await this.getOrCreatePiSession(opts.effort);
      unsubscribe = session.subscribe((event) => {
        if (this.state !== 'stopped') this.emitMappedPiEvent(event);
      });

      log(`started (resume=${!!opts.resume}, model=${this.model})`);
      await session.prompt(opts.prompt, opts.resume ? { streamingBehavior: 'followUp' } : undefined);

      if (this.state !== 'stopped' && this.asyncTasks.hasPending()) {
        log('waiting for async task notifications before session_exit');
        await this.waitForAsyncTasks();
      }

      if (this.state !== 'stopped') {
        this.state = 'completed';
      }
      log(`exited (state=${this.state})`);
    } catch (err) {
      log(`caught error in run loop: ${err instanceof Error ? err.message : err}`);
      const errStr = String(err);
      if (errStr.includes('abort') || errStr.includes('AbortError')) {
        this.state = 'stopped';
        log('stopped');
      } else {
        this.state = 'errored';
        log(`error: ${errStr}`);
        const msg: SessionErrorMessage = {
          type: 'error',
          sessionId: this.id,
          error: errStr,
        };
        for (const cb of this.subscribers) cb(msg);
      }
    } finally {
      this.running = false;
      const activeSession = this.piSession;
      await this.runBeforeExitHooks();
      const exitMsg: SessionExitMessage = {
        type: 'session_exit',
        sessionId: this.id,
        state: this.state as 'completed' | 'errored' | 'stopped',
      };
      for (const cb of this.subscribers) cb(exitMsg);
      if (activeSession === this.piSession) unsubscribe();
    }
  }

  /**
   * Send a follow-up message (resume into existing session).
   */
  async sendMessage(prompt: string, effort?: string): Promise<void> {
    if (!this.running) this.state = 'running';
    await this.run({ prompt, resume: true, effort });
  }

  /**
   * Change thinking budget mid-session.
   */
  async setEffort(effort: string): Promise<void> {
    if (!this.piSession) {
      console.log(`[orcd:${this.id.slice(0, 8)}] setEffort(${effort}): no active pi session, skipping`);
      return;
    }
    await this.piSession.setEffort(effort);
    console.log(`[orcd:${this.id.slice(0, 8)}] effort → ${effort}`);
  }

  /**
   * Cancel the running session.
   */
  async cancel(): Promise<void> {
    this.state = 'stopped';
    if (this.piSession) {
      await this.piSession.abort();
    }
  }

  async compact(): Promise<unknown> {
    const session = await this.getOrCreatePiSession(undefined);
    return session.compact();
  }

  /**
   * Broadcast a synthetic compact_boundary stream_event so downstream
   * listeners can reset contextTokens immediately.
   */
  emitCompactBoundary(): void {
    this.emitSyntheticSystemEvent('compact_boundary');
  }

  emitBgcStarted(): void {
    this.emitSyntheticSystemEvent('bgc_started');
  }

  private emitSyntheticSystemEvent(subtype: 'compact_boundary' | 'bgc_started'): void {
    const event = {
      type: 'system',
      subtype,
      session_id: this.id,
      source: 'orchestrel-bgc',
      timestamp: Date.now(),
    };
    const eventIndex = this.buffer.push(event);
    const msg: StreamEventMessage = {
      type: 'stream_event',
      sessionId: this.id,
      eventIndex,
      event,
    };
    for (const cb of this.subscribers) cb(msg);
  }
}
