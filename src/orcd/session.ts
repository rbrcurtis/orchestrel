import { randomUUID } from 'crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options } from '@anthropic-ai/claude-agent-sdk';
import { RingBuffer } from './ring-buffer';
import type { SessionState } from './types';
import type { StreamEventMessage, SessionErrorMessage, SessionResultMessage, SessionExitMessage } from '../shared/orcd-protocol';

export type SessionEventCallback = (msg: StreamEventMessage | SessionResultMessage | SessionErrorMessage | SessionExitMessage) => void;

/**
 * Map effort string to SDK options for thinking/effort.
 */
function effortToOptions(effort: string | undefined): Pick<Options, 'effort' | 'thinking'> {
  if (effort === 'disabled') {
    return { thinking: { type: 'disabled' } };
  }
  const level = effort ?? 'high';
  if (level === 'low' || level === 'medium' || level === 'high' || level === 'max') {
    return { effort: level };
  }
  return { effort: 'high' };
}

export class OrcdSession {
  readonly id: string;
  state: SessionState = 'running';
  readonly cwd: string;
  readonly model: string;
  readonly provider: string;
  readonly buffer: RingBuffer<unknown>;

  private activeQuery: Query | null = null;
  private subscribers = new Set<SessionEventCallback>();

  constructor(opts: {
    cwd: string;
    model: string;
    provider: string;
    bufferSize?: number;
    sessionId?: string;  // For resume — use existing CC session UUID
  }) {
    this.id = opts.sessionId ?? randomUUID();
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.provider = opts.provider;
    this.buffer = new RingBuffer(opts.bufferSize ?? 1000);
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

    const q = sdkQuery({
      prompt: opts.prompt,
      options: {
        ...(opts.resume ? { resume: this.id } : { sessionId: this.id }),
        cwd: this.cwd,
        model: this.model,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['user', 'project'],
        includePartialMessages: true,
        pathToClaudeCodeExecutable: '/home/ryan/.local/bin/claude',
        env: opts.env,
        ...thinkingOpts,
      },
    });

    this.activeQuery = q;
    log(`started (resume=${!!opts.resume}, model=${this.model})`);

    try {
      for await (const event of q) {
        if (this.state === 'stopped') break;

        const sdkEvent = event as Record<string, unknown>;
        const eventIndex = this.buffer.push(sdkEvent);

        log(JSON.stringify(sdkEvent));

        if (sdkEvent.type === 'result') {
          const msg: SessionResultMessage = {
            type: 'result',
            sessionId: this.id,
            eventIndex,
            result: sdkEvent,
          };
          for (const cb of this.subscribers) cb(msg);
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
    if (!this.activeQuery) return;
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
}
