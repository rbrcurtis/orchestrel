import { randomUUID } from 'crypto';
import type { AgentEvent } from '@oh-my-pi/pi-agent-core';
import { ThinkingLevel } from '@oh-my-pi/pi-agent-core';
import { createAgentSession, type CreateAgentSessionResult, type CreateAgentSessionOptions } from '@oh-my-pi/pi-coding-agent';
import { RingBuffer } from './ring-buffer';
import { resolveModel } from './model-registry';
import { createRollingWindowExtension } from './extensions/rolling-window';
import { createCacheBreakpointExtension } from './extensions/cache-breakpoints';
import { createMemoryUpsertExtension } from './extensions/memory-upsert';
import { createMemoryTools } from './tools/memory';
import type { SessionState, PiSessionOptions } from './types';
import type {
  StreamEventMessage,
  SessionResultMessage,
  SessionErrorMessage,
  SessionExitMessage,
} from '../shared/orcd-protocol';

export type SessionEventCallback = (
  msg: StreamEventMessage | SessionResultMessage | SessionErrorMessage | SessionExitMessage,
) => void;

/** Estimated system prompt token count — subtracted from contextWindow for message budget. */
const SYSTEM_PROMPT_TOKENS = 22_000;

/** Default turns between memory upserts. */
const MEMORY_UPSERT_INTERVAL = 5;

/**
 * Map orcd effort string to pi ThinkingLevel.
 * 'disabled' → Off, 'low'/'medium'/'high' → same, default → High.
 */
function effortToThinkingLevel(effort: string | undefined): ThinkingLevel {
  if (effort === 'disabled') return ThinkingLevel.Off;
  if (effort === 'minimal') return ThinkingLevel.Minimal;
  if (effort === 'low') return ThinkingLevel.Low;
  if (effort === 'medium') return ThinkingLevel.Medium;
  if (effort === 'high') return ThinkingLevel.High;
  return ThinkingLevel.High;
}

/**
 * PiSession wraps a pi-coding-agent AgentSession to match the orcd protocol.
 *
 * Drop-in replacement for OrcdSession — same external interface consumed
 * by the socket server and session store.
 */
export class PiSession {
  readonly id: string;
  state: SessionState = 'running';
  readonly cwd: string;
  readonly model: string;
  readonly provider: string;
  readonly contextWindow: number | undefined;
  readonly buffer: RingBuffer<unknown>;

  private piResult: CreateAgentSessionResult | null = null;
  private unsubscribePi: (() => void) | null = null;
  private subscribers = new Set<SessionEventCallback>();
  private readonly opts: PiSessionOptions;

  constructor(opts: PiSessionOptions) {
    this.id = opts.sessionId ?? randomUUID();
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.provider = opts.provider;
    this.contextWindow = opts.contextWindow;
    this.buffer = new RingBuffer(opts.bufferSize ?? 1000);
    this.opts = opts;
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
   * Create the pi session, subscribe to events, send the initial prompt,
   * and wait for the agent to finish.
   */
  async run(opts: { prompt: string; resume?: boolean; effort?: string }): Promise<void> {
    const log = (msg: string) => console.log(`[orcd:${this.id.slice(0, 8)}] ${msg}`);
    const thinkingLevel = effortToThinkingLevel(opts.effort);

    try {
      // Build extensions
      const messageBudget = (this.contextWindow ?? 200_000) - SYSTEM_PROMPT_TOKENS;
      const extensions = [
        createRollingWindowExtension({
          messageBudgetTokens: messageBudget,
          onEviction: (evicted, remaining) => {
            log(`evicted ${evicted} messages, ${remaining} remaining`);
          },
        }),
        createCacheBreakpointExtension(),
      ];

      // Only add memory upsert if openrouter is available
      if (this.opts.openrouterConfig) {
        extensions.push(
          createMemoryUpsertExtension({
            turnsPerUpsert: MEMORY_UPSERT_INTERVAL,
            openrouterConfig: this.opts.openrouterConfig,
            project: this.opts.project ?? this.cwd,
          }),
        );
      }

      // Resolve the pi-ai Model object
      const piModel = resolveModel(this.model, this.provider, this.opts.providerConfig);

      // Create pi session
      const result = await createAgentSession({
        cwd: this.cwd,
        model: piModel,
        thinkingLevel,
        extensions,
        customTools: createMemoryTools() as unknown as NonNullable<CreateAgentSessionOptions['customTools']>,
        hasUI: false,
        enableMCP: false,
        enableLsp: false,
      });

      this.piResult = result;
      const { session } = result;

      log(`started (resume=${!!opts.resume}, model=${this.model}, thinking=${thinkingLevel})`);

      // Subscribe to pi events and map to orcd protocol
      this.unsubscribePi = session.subscribe((event) => {
        if (this.state === 'stopped') return;

        const piEvent = event as AgentEvent & Record<string, unknown>;
        const eventIndex = this.buffer.push(piEvent);

        if (piEvent.type === 'turn_end') {
          // turn_end → result message
          const msg: SessionResultMessage = {
            type: 'result',
            sessionId: this.id,
            eventIndex,
            result: piEvent,
          };
          this.broadcast(msg);
        } else {
          // All other events → stream_event
          const msg: StreamEventMessage = {
            type: 'stream_event',
            sessionId: this.id,
            eventIndex,
            event: piEvent,
          };
          this.broadcast(msg);
        }
      });

      // Send initial prompt
      await session.prompt(opts.prompt);

      // Wait for agent to finish all work
      await session.waitForIdle();

      if (this.state !== 'stopped') {
        this.state = 'completed';
      }
      log(`exited (state=${this.state})`);
    } catch (err) {
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
        this.broadcast(msg);
      }
    } finally {
      this.cleanup();
      const exitMsg: SessionExitMessage = {
        type: 'session_exit',
        sessionId: this.id,
        state: this.state as 'completed' | 'errored' | 'stopped',
      };
      this.broadcast(exitMsg);
    }
  }

  /**
   * Send a follow-up prompt to an existing pi session.
   */
  async sendMessage(prompt: string, effort?: string): Promise<void> {
    const log = (msg: string) => console.log(`[orcd:${this.id.slice(0, 8)}] ${msg}`);

    if (!this.piResult) {
      log('sendMessage called but no pi session exists, creating new session');
      this.state = 'running';
      await this.run({ prompt, resume: true, effort });
      return;
    }

    this.state = 'running';
    const { session } = this.piResult;

    // Update thinking level if effort changed
    if (effort) {
      const level = effortToThinkingLevel(effort);
      session.setThinkingLevel(level);
    }

    try {
      await session.prompt(prompt);
      await session.waitForIdle();

      // State may have been changed to 'stopped' by cancel() during the await
      if ((this.state as SessionState) !== 'stopped') {
        this.state = 'completed';
      }
      log(`follow-up exited (state=${this.state})`);
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('abort') || errStr.includes('AbortError')) {
        this.state = 'stopped';
        log('stopped');
      } else {
        this.state = 'errored';
        log(`error: ${errStr}`);
        this.broadcast({
          type: 'error',
          sessionId: this.id,
          error: errStr,
        });
      }
    } finally {
      const exitMsg: SessionExitMessage = {
        type: 'session_exit',
        sessionId: this.id,
        state: this.state as 'completed' | 'errored' | 'stopped',
      };
      this.broadcast(exitMsg);
    }
  }

  /**
   * Cancel the running session.
   */
  async cancel(): Promise<void> {
    this.state = 'stopped';
    if (this.piResult) {
      await this.piResult.session.abort();
    }
  }

  private broadcast(msg: StreamEventMessage | SessionResultMessage | SessionErrorMessage | SessionExitMessage): void {
    for (const cb of this.subscribers) cb(msg);
  }

  private cleanup(): void {
    if (this.unsubscribePi) {
      this.unsubscribePi();
      this.unsubscribePi = null;
    }
  }
}
