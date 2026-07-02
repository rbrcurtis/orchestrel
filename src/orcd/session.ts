/* oxlint-disable orchestrel/log-before-early-return -- session lifecycle guards intentionally return existing state without noisy per-event logs */
import { randomUUID } from 'crypto';
import { AsyncTaskTracker, extractAsyncAgentLaunches, parseTaskNotification } from './async-task-tracker';
import { getContextUsageFromPiEvent, mapPiEventToOrcdPayload, mapSubagentExecEvent } from './pi-events';
import { createPiRuntimeSession, type PiRuntimeSession } from './pi-runtime';
import { hasEnabledScheduledJobs } from '../shared/scheduled-jobs';
import { RingBuffer } from './ring-buffer';
import type { CompactionResult } from '@earendil-works/pi-coding-agent';
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
  private readonly scheduledJobPollMs: number;

  private piSession: PiRuntimeSession | null = null;
  private initEmitted = false;
  private running = false;
  // Per-run() exit bookkeeping. A run is identified by runEpoch so a forced
  // exit from cancel() can't clobber a later resumed turn (see finalizeExit).
  private runEpoch = 0;
  private exitFinalized = false;
  private currentUnsubscribe: (() => void) | null = null;
  // How long cancel() waits for abort() to unwind the run loop naturally before
  // forcing session_exit itself (handles tools wedged on an un-abortable read).
  private readonly cancelGraceMs: number;
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
    scheduledJobPollMsForTesting?: number;
    cancelGraceMsForTesting?: number;
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
    // Scheduled jobs wait minutes-to-hours; poll the store file slowly.
    this.scheduledJobPollMs = opts.scheduledJobPollMsForTesting ?? 15_000;
    this.cancelGraceMs = opts.cancelGraceMsForTesting ?? 4000;
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

  // Hold the session open while its worktree has an enabled scheduled job. The
  // pi-subagents scheduler's timer lives in this process; keeping the session
  // alive keeps the card parked (reaper- and reconcile-exempt) and isActive
  // true until the job fires (enabled flips false) or the session is cancelled.
  private async waitForScheduledJobs(): Promise<void> {
    while (this.state !== 'stopped' && hasEnabledScheduledJobs(this.cwd)) {
      await new Promise((resolve) => setTimeout(resolve, this.scheduledJobPollMs));
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

  /** Context window for the active model — Pi usage events don't carry one. */
  private resolveContextWindow(): number | undefined {
    if (this.contextWindow && this.contextWindow > 0) return this.contextWindow;
    const fromConfig = this.providerConfig?.models[this.model]?.contextWindow;
    return fromConfig && fromConfig > 0 ? fromConfig : undefined;
  }

  private emitMappedPiEvent(event: unknown): void {
    if (this.isRecord(event) && event.type === 'compaction_start') {
      // A manual `/compact` (reason 'manual') is a distinct, foreground full
      // compaction — NOT the background compactor. Keep its lifecycle separate so
      // the UI labels it correctly and flips the session back to idle when done.
      if (event.reason === 'manual') this.emitCompactStarted();
      else this.emitBgcStarted();
      return;
    }
    if (this.isRecord(event) && event.type === 'compaction_end') {
      // Manual `/compact` finished → terminal compact_done (UI returns to idle).
      // Otherwise it's Pi's own auto-compaction (the ~92% safety net) — surface a
      // compact_boundary so the UI context wheel resets even when BGC didn't drive it.
      if (event.reason === 'manual') this.emitCompactDone();
      else this.emitCompactBoundary();
      return;
    }
    const usage = getContextUsageFromPiEvent(event, this.resolveContextWindow());
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
      // A turn is already streaming. Pi queues messages natively, so hand the
      // prompt to its queue (followUp = run after the current turn finishes)
      // instead of dropping it. The in-flight run()'s await on session.prompt()
      // only resolves once Pi drains the queue, so session_exit still fires at
      // the right time and events keep flowing through the existing
      // subscription — this branch starts no second run loop.
      if (this.piSession) {
        log('session running; queueing overlapping prompt as followUp');
        await this.piSession.prompt(opts.prompt, { streamingBehavior: 'followUp' });
      } else {
        log('session running but no pi session yet; dropping overlapping prompt');
      }
      return;
    }

    this.running = true;
    const epoch = ++this.runEpoch;
    this.exitFinalized = false;
    try {
      const session = await this.getOrCreatePiSession(opts.effort);
      if (!this.initEmitted) {
        this.initEmitted = true;
        this.emitSessionInit();
      }
      const unsubscribe = session.subscribe((event) => {
        if (this.state !== 'stopped') this.emitMappedPiEvent(event);
      });
      // Only detach if the active pi session hasn't been swapped out (fork).
      this.currentUnsubscribe = () => {
        if (session === this.piSession) unsubscribe();
      };

      log(`started (resume=${!!opts.resume}, model=${this.model})`);
      await session.prompt(opts.prompt, opts.resume ? { streamingBehavior: 'followUp' } : undefined);

      if (this.state !== 'stopped' && this.asyncTasks.hasPending()) {
        log('waiting for async task notifications before session_exit');
        await this.waitForAsyncTasks();
      }

      if (this.state !== 'stopped' && hasEnabledScheduledJobs(this.cwd)) {
        log('enabled scheduled jobs present; staying alive until they fire');
        await this.waitForScheduledJobs();
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
      await this.finalizeExit(epoch);
    }
  }

  /**
   * Re-instantiate the session WITHOUT running a turn, purely to re-arm the
   * in-process pi-subagents scheduler (its timer lives only in orcd memory and
   * is lost on restart). Binding extensions arms enabled jobs; we then hold the
   * session open via waitForScheduledJobs so the card stays parked and isActive
   * stays true until the job fires. No prompt, no model call. No-op if a turn is
   * already live (the scheduler is already armed).
   */
  async warm(): Promise<void> {
    if (this.running) {
      console.log(`[orcd:${this.id.slice(0, 8)}] warm: session already active, skipping`);
      return;
    }
    this.running = true;
    const epoch = ++this.runEpoch;
    this.exitFinalized = false;
    const log = (msg: string) => console.log(`[orcd:${this.id.slice(0, 8)}] ${msg}`);
    try {
      const session = await this.getOrCreatePiSession(undefined); // bindExtensions arms the scheduler
      if (!this.initEmitted) {
        this.initEmitted = true;
        this.emitSessionInit();
      }
      const unsubscribe = session.subscribe((event) => {
        if (this.state !== 'stopped') this.emitMappedPiEvent(event);
      });
      this.currentUnsubscribe = () => {
        if (session === this.piSession) unsubscribe();
      };

      log(`warmed (model=${this.model}); holding for scheduled jobs`);
      if (this.state !== 'stopped' && hasEnabledScheduledJobs(this.cwd)) {
        await this.waitForScheduledJobs();
      }
      if (this.state !== 'stopped') this.state = 'completed';
      log(`warm exited (state=${this.state})`);
    } catch (err) {
      log(`warm error: ${err instanceof Error ? err.message : String(err)}`);
      this.state = 'errored';
      const msg: SessionErrorMessage = { type: 'error', sessionId: this.id, error: String(err) };
      for (const cb of this.subscribers) cb(msg);
    } finally {
      await this.finalizeExit(epoch);
    }
  }

  /**
   * Emit session_exit and tear down the run's subscription — exactly once per
   * run() invocation. Called from run()'s finally on natural completion AND from
   * cancel() when abort() can't unwind a wedged turn (e.g. a tool blocked on a
   * native read that won't observe the abort signal). Idempotent and epoch-
   * guarded: a stale call from an abandoned run can't fire session_exit for, or
   * detach the subscription of, a newer resumed turn.
   */
  private async finalizeExit(epoch: number): Promise<void> {
    if (epoch !== this.runEpoch || this.exitFinalized) return;
    this.exitFinalized = true;
    this.running = false;
    await this.runBeforeExitHooks();
    const exitMsg: SessionExitMessage = {
      type: 'session_exit',
      sessionId: this.id,
      state: this.state as 'completed' | 'errored' | 'stopped',
    };
    for (const cb of this.subscribers) cb(exitMsg);
    this.currentUnsubscribe?.();
    this.currentUnsubscribe = null;
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
    const epoch = this.runEpoch;
    if (this.piSession) {
      await this.piSession.abort();
    }
    // abort() asks pi's turn loop to stop, but a tool blocked on an un-abortable
    // native read (e.g. a wedged ssh whose backgrounded ControlMaster keeps the
    // captured stdout pipe open) won't observe it — prompt() never resolves, so
    // run()'s finally never runs and the card stays stuck in "running". Poll
    // briefly for the loop to unwind on its own; if it doesn't within the grace
    // window, force session_exit so the card reliably reconciles. finalizeExit is
    // idempotent + epoch-guarded, so a later natural resolution (or a resumed
    // turn) is unaffected.
    const step = 50;
    for (let waited = 0; this.running && epoch === this.runEpoch && waited < this.cancelGraceMs; waited += step) {
      await new Promise((resolve) => setTimeout(resolve, step));
    }
    if (this.running && epoch === this.runEpoch) {
      console.log(`[orcd:${this.id.slice(0, 8)}] cancel: run loop wedged after abort; forcing session_exit`);
      await this.finalizeExit(epoch);
    }
  }

  async compact(): Promise<unknown> {
    const session = await this.getOrCreatePiSession(undefined);
    return session.compact();
  }

  /** True when no turn is currently streaming — safe to splice a compaction. */
  isIdle(): boolean {
    return !this.running;
  }

  /** True when the newest branch entry is already a compaction (Pi safety net beat us). */
  latestEntryIsCompaction(): boolean {
    return this.piSession?.latestEntryIsCompaction() ?? false;
  }

  /** Run an out-of-band BGC summary. Parallel-safe; null = nothing to compact. */
  async prepareBgCompaction(keepFraction: number, signal: AbortSignal): Promise<CompactionResult | null> {
    const session = await this.getOrCreatePiSession(undefined);
    return session.prepareBgCompaction(keepFraction, this.lastContextTokens, signal);
  }

  /** Splice a prepared BGC compaction into the session tree. Call only when idle. */
  applyBgCompaction(result: CompactionResult): void {
    if (!this.piSession) return;
    this.piSession.applyBgCompaction(result);
    this.emitCompactBoundary();
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

  /** Foreground full-compaction (`/compact`) lifecycle — distinct from BGC so the
   *  UI shows a "Compacting" marker and returns the session to idle on done. */
  emitCompactStarted(): void {
    this.emitSyntheticSystemEvent('compact_started', 'orchestrel-compact');
  }

  emitCompactDone(): void {
    this.emitSyntheticSystemEvent('compact_done', 'orchestrel-compact');
  }

  /**
   * Emit a synthetic `system`/`init` event so the UI renders its "Session started
   * · <model>" line. The Claude Agent SDK emitted this natively; Pi does not, so
   * orcd synthesizes it once per session lifecycle (first run). The history path
   * synthesizes its own init from the persisted session context (see
   * pi-session-history), so reopening a card stays consistent.
   */
  private emitSessionInit(): void {
    const model = this.providerConfig?.models[this.model]?.modelID ?? this.model;
    const event = {
      type: 'system',
      subtype: 'init',
      session_id: this.id,
      model,
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

  private emitSyntheticSystemEvent(
    subtype: 'compact_boundary' | 'bgc_started' | 'compact_started' | 'compact_done',
    source = 'orchestrel-bgc',
  ): void {
    const event = {
      type: 'system',
      subtype,
      session_id: this.id,
      source,
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
