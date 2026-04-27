import { randomUUID } from 'crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options } from '@anthropic-ai/claude-agent-sdk';
import { AUTO_COMPACT_RATIO } from '../shared/constants';
import { RingBuffer } from './ring-buffer';
import type { SessionState } from './types';
import type { StreamEventMessage, SessionErrorMessage, SessionResultMessage, SessionExitMessage, ContextUsageMessage, SessionIdUpdateMessage } from '../shared/orcd-protocol';

export type SessionEventCallback = (msg: StreamEventMessage | SessionResultMessage | SessionErrorMessage | SessionExitMessage | ContextUsageMessage | SessionIdUpdateMessage) => void;

/**
 * Map effort string to SDK options for thinking/effort.
 */
function effortToOptions(effort: string | undefined): Pick<Options, 'effort' | 'thinking'> {
  if (effort === 'disabled') {
    console.log(`[orcd:effort] disabled → thinking.type=disabled`);
    return { thinking: { type: 'disabled' } };
  }
  const level = effort ?? 'high';
  if (level !== 'low' && level !== 'medium' && level !== 'high' && level !== 'max') {
    console.warn(`[orcd:effort] unknown level "${level}", defaulting to high`);
    return { effort: 'high' };
  }
  return { effort: level };
}

const SESSION_DISABLED_TOOLS = [
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
] as const;

export class OrcdSession {
  readonly id: string;
  state: SessionState = 'running';
  readonly cwd: string;
  readonly model: string;
  readonly provider: string;
  readonly contextWindow: number | undefined;
  readonly summarizeThreshold: number;
  readonly buffer: RingBuffer<unknown>;

  /** Last known context token count (updated after each result) */
  lastContextTokens = 0;
  lastContextWindow = 0;

  private readonly jsonlPathForTesting: string | undefined;
  private readonly asyncTaskPollMs: number;

  private activeQuery: Query | null = null;
  private subscribers = new Set<SessionEventCallback>();
  private onFork: ((oldId: string, newId: string) => void) | undefined;
  private forkedTo: string | undefined;

  constructor(opts: {
    cwd: string;
    model: string;
    provider: string;
    bufferSize?: number;
    sessionId?: string;  // For resume — use existing CC session UUID
    contextWindow?: number;
    summarizeThreshold?: number;
    onFork?: (oldId: string, newId: string) => void;
    jsonlPathForTesting?: string;
    asyncTaskPollMsForTesting?: number;
  }) {
    this.id = opts.sessionId ?? randomUUID();
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.provider = opts.provider;
    this.contextWindow = opts.contextWindow;
    this.summarizeThreshold = opts.summarizeThreshold ?? 0;
    this.buffer = new RingBuffer(opts.bufferSize ?? 1000);
    this.onFork = opts.onFork;
    this.jsonlPathForTesting = opts.jsonlPathForTesting;
    this.asyncTaskPollMs = opts.asyncTaskPollMsForTesting ?? 1000;
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

  /**
   * Start or resume a session.
   * Consumes the Agent SDK async iterator and broadcasts events.
   */
  async run(opts: {
    prompt: string;
    resume?: boolean;
    env?: Record<string, string>;
    effort?: string;
  }): Promise<void> {
    const log = (msg: string) => console.log(`[orcd:${this.id.slice(0, 8)}] ${msg}`);

    const thinkingOpts = effortToOptions(opts.effort);

    // SDK validates autoCompactWindow as min(100000), silently drops values below
    const autoCompactWindow = this.contextWindow
      ? Math.max(Math.floor(this.contextWindow * AUTO_COMPACT_RATIO), 100_000)
      : undefined;

    const q = sdkQuery({
      prompt: opts.prompt,
      options: {
        ...(opts.resume ? { resume: this.id } : { sessionId: this.id }),
        cwd: this.cwd,
        model: this.model,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        disallowedTools: [...SESSION_DISABLED_TOOLS],
        settingSources: ['user', 'project'],
        includePartialMessages: true,
        pathToClaudeCodeExecutable: '/home/ryan/.local/bin/claude',
        env: opts.env,
        ...thinkingOpts,
        ...(autoCompactWindow ? { settings: { autoCompactWindow } } : {}),
      },
    });

    this.activeQuery = q;
    log(`started (resume=${!!opts.resume}, model=${this.model})`);

    try {
      // Track the last message_start usage per API call — used to compute
      // context fill on result (getContextUsage() fails because the subprocess
      // exits before the response arrives).
      let lastInputTokens = 0;

      for await (const event of q) {
        if (this.state === 'stopped') break;

        const sdkEvent = event as Record<string, unknown>;
        const eventIndex = this.buffer.push(sdkEvent);

        log(JSON.stringify(sdkEvent));

        // Detect CC session fork: on resume, CC may allocate a new session_id
        // and write to a new JSONL. The init event carries the new id. We
        // still route everything under this.id, but announce the new id so
        // the backend can persist it for the next resume.
        if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
          const ccSessionId = sdkEvent.session_id;
          if (typeof ccSessionId === 'string' && ccSessionId !== this.id && ccSessionId !== this.forkedTo) {
            this.forkedTo = ccSessionId;
            this.onFork?.(this.id, ccSessionId);
            const upd: SessionIdUpdateMessage = {
              type: 'session_id_update',
              sessionId: this.id,
              newSessionId: ccSessionId,
            };
            for (const cb of this.subscribers) cb(upd);
            log(`session forked: ${this.id.slice(0,8)} → ${ccSessionId.slice(0,8)}`);
          }
        }

        // Track per-API-call input tokens from message_start events.
        // SDK yields { type: 'stream_event', event: { type: 'message_start', message: { usage } } }
        // Fallback: also check message_delta usage (KPP sends context-derived input_tokens there
        // because CW's contextUsagePercentage arrives after content, too late for message_start).
        if (sdkEvent.type === 'stream_event') {
          const inner = sdkEvent.event as Record<string, unknown> | undefined;
          if (inner?.type === 'message_start') {
            const msg = inner.message as Record<string, unknown> | undefined;
            const u = msg?.usage as Record<string, number> | undefined;
            if (u) {
              lastInputTokens =
                (u.input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0);
            }
          } else if (inner?.type === 'message_delta' && lastInputTokens === 0) {
            const u = inner.usage as Record<string, number> | undefined;
            if (u?.input_tokens && u.input_tokens > 0) {
              lastInputTokens = u.input_tokens;
            }
          }
        }

        if (sdkEvent.type === 'result') {
          const msg: SessionResultMessage = {
            type: 'result',
            sessionId: this.id,
            eventIndex,
            result: sdkEvent,
          };
          for (const cb of this.subscribers) cb(msg);

          // Emit context usage from the last message_start's per-call tokens
          if (lastInputTokens > 0) {
            // Get contextWindow from result's modelUsage if available
            const mu = sdkEvent.modelUsage as Record<string, Record<string, number>> | undefined;
            let ctxWindow = this.contextWindow || 200_000;
            if (mu) {
              const first = Object.values(mu)[0];
              if (first?.contextWindow) ctxWindow = first.contextWindow;
            }
            this.lastContextTokens = lastInputTokens;
            this.lastContextWindow = ctxWindow;
            const cuMsg: ContextUsageMessage = {
              type: 'context_usage',
              sessionId: this.id,
              contextTokens: lastInputTokens,
              contextWindow: ctxWindow,
            };
            for (const cb of this.subscribers) cb(cuMsg);
          }
        } else {
          const msg: StreamEventMessage = {
            type: 'stream_event',
            sessionId: this.id,
            eventIndex,
            event: sdkEvent,
          };
          for (const cb of this.subscribers) cb(msg);
        }
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
        log(`stopped`);
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
      this.activeQuery = null;
      const exitMsg: SessionExitMessage = {
        type: 'session_exit',
        sessionId: this.id,
        state: this.state as 'completed' | 'errored' | 'stopped',
      };
      for (const cb of this.subscribers) cb(exitMsg);
    }
  }

  /**
   * Send a follow-up message (resume into existing session).
   */
  async sendMessage(prompt: string, env?: Record<string, string>, effort?: string): Promise<void> {
    this.state = 'running';
    await this.run({ prompt, resume: true, env, effort });
  }

  /**
   * Change thinking budget mid-session.
   */
  async setEffort(effort: string): Promise<void> {
    if (!this.activeQuery) {
      console.log(`[orcd:${this.id.slice(0, 8)}] setEffort(${effort}): no active query, skipping`);
      return;
    }
    // setMaxThinkingTokens is deprecated but still the only mid-session API
    const budget = effort === 'disabled' ? 0 : null;
    await this.activeQuery.setMaxThinkingTokens(budget);
    console.log(`[orcd:${this.id.slice(0, 8)}] effort → ${effort} (budget=${budget})`);
  }

  /**
   * Cancel the running session.
   */
  async cancel(): Promise<void> {
    this.state = 'stopped';
    if (this.activeQuery) {
      await this.activeQuery.interrupt();
    }
  }

  /**
   * Broadcast a synthetic compact_boundary stream_event so downstream
   * listeners (orchestrel card-sessions.ts compact_boundary handler) can
   * reset contextTokens immediately, without waiting for the SDK to replay
   * the JSONL on next resume. Used by orchestrel's background compactor
   * after applyCompaction() rewrites the JSONL.
   */
  emitCompactBoundary(): void {
    const event = {
      type: 'system',
      subtype: 'compact_boundary',
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
