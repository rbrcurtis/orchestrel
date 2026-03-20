import { AgentSession } from '../types';
import type { SessionStatus, AgentMessage } from '../types';
import { normalizeOpenCodeEvent } from './messages';
import { resolveModel } from './models';

interface SdkClient {
  session: {
    create(opts: { title: string; directory: string }): Promise<{ data?: { id: string }; id?: string }>;
    prompt(opts: {
      sessionID: string;
      parts: { type: string; text: string }[];
      model: { providerID: string; modelID: string };
      variant?: string;
      directory: string;
      tools?: Record<string, boolean>;
    }): Promise<void>;
    abort(opts: { sessionID: string }): Promise<void>;
    children(opts: { sessionID: string }): Promise<Array<{ id: string; title: string; parentID?: string }>>;
  };
  event: {
    subscribe(
      params: { directory?: string },
      opts?: { signal?: AbortSignal },
    ): Promise<{ stream: AsyncIterable<{ type: string; properties: Record<string, unknown> }> }>;
  };
  permission: {
    reply(opts: { requestID: string; reply: 'once' | 'always' | 'reject' }): Promise<unknown>;
  };
}

export class OpenCodeSession extends AgentSession {
  sessionId: string | null = null;
  private _status: SessionStatus = 'starting';
  promptsSent = 0;
  turnsCompleted = 0;

  private static PROMPT_TIMEOUT_MS = 60_000;

  private abortController: AbortController | null = null;
  private sseCleanup: (() => void) | null = null;
  private sseAlive = false;
  private promptTimer: ReturnType<typeof setTimeout> | null = null;
  private idleFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private turnCost = 0;
  private turnTokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
  private userMessageIds = new Set<string>();
  private childSessions = new Map<string, { title: string; status: string }>();
  private childrenResolvePending = false;
  private _stopRequested = false;
  private stopRetryInterval: ReturnType<typeof setInterval> | null = null;
  private static STOP_TIMEOUT_MS = 30_000;

  constructor(
    private client: unknown,
    private cwd: string,
    private providerID: string,
    private modelID: string,
    private variant: string | undefined,
    private resumeSessionId?: string,
  ) {
    super();
    if (resumeSessionId) {
      this.sessionId = resumeSessionId;
    }
  }

  override get status(): SessionStatus {
    return this._status;
  }
  override set status(val: SessionStatus) {
    if (val !== this._status) {
      this.log(`status: ${this._status} → ${val}`);
      this._status = val;
      this.emit('statusChange', val);
    }
  }

  private resetPromptTimer(reason: string): void {
    this.log(`timer:reset reason=${reason}`);
    if (this.promptTimer) clearTimeout(this.promptTimer);
    this.promptTimer = setTimeout(() => {
      this.log(
        `prompt:quiet after ${OpenCodeSession.PROMPT_TIMEOUT_MS}ms (status=${this._status}, turns=${this.turnsCompleted}, prompts=${this.promptsSent}) — checking OC`,
      );
      void this.checkSessionAlive();
    }, OpenCodeSession.PROMPT_TIMEOUT_MS);
  }

  private async checkSessionAlive(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const port = Number(process.env.OPENCODE_PORT ?? 4097);
      const res = await fetch(`http://localhost:${port}/session/status`, {
        headers: { 'x-opencode-directory': this.cwd },
      });
      if (!res.ok) {
        this.log(`oc:status-check failed (HTTP ${res.status})`);
        return;
      }
      const statuses = (await res.json()) as Record<string, { type: string }>;
      const status = statuses[this.sessionId];
      if (status?.type === 'busy') {
        this.log('oc:alive — session still busy, resetting timer');
        this.resetPromptTimer('oc:alive');
      } else {
        this.log(`oc:idle — session status=${status?.type ?? 'missing'}`);
      }
    } catch (err) {
      this.log(`oc:status-check error: ${err}`);
    }
  }

  private clearPromptTimer(reason: string): void {
    if (this.promptTimer) {
      this.log(`timer:clear reason=${reason}`);
      clearTimeout(this.promptTimer);
    }
    this.promptTimer = null;
  }

  private clearIdleFallbackTimer(): void {
    if (this.idleFallbackTimer) clearTimeout(this.idleFallbackTimer);
    this.idleFallbackTimer = null;
  }

  private log(msg: string): void {
    console.log(`[session:${this.sessionId ?? 'pending'}] ${msg}`);
  }

  private logChild(childId: string, msg: string): void {
    console.log(`[session:${this.sessionId ?? 'pending'}:child:${childId}] ${msg}`);
  }

  private async resolveChildren(triggeringChildId?: string): Promise<void> {
    if (this.childrenResolvePending || !this.sessionId) {
      // Still insert placeholder so this child isn't permanently unknown
      if (triggeringChildId && !this.childSessions.has(triggeringChildId)) {
        this.childSessions.set(triggeringChildId, { title: triggeringChildId.slice(0, 12), status: 'running' });
        this.log(`child:placeholder ${triggeringChildId}`);
      }
      return;
    }
    this.childrenResolvePending = true;
    try {
      const sdk = this.client as unknown as SdkClient;
      const res = await sdk.session.children({ sessionID: this.sessionId });
      // SDK may wrap response in { data: [...] } or return bare array
      const children = Array.isArray(res)
        ? res
        : (((res as Record<string, unknown>).data as Array<{ id: string; title: string; parentID?: string }>) ?? []);
      if (!Array.isArray(children)) {
        this.log(`child:resolve-unexpected response=${JSON.stringify(res).slice(0, 200)}`);
        return;
      }
      for (const child of children) {
        if (!this.childSessions.has(child.id)) {
          this.childSessions.set(child.id, { title: child.title, status: 'running' });
          this.log(`child:discovered ${child.id} title="${child.title.slice(0, 60)}"`);
        }
      }
    } catch (err) {
      this.log(`child:resolve-error ${err}`);
      // Use child session ID as placeholder title — retry resolution on next event
      if (triggeringChildId && !this.childSessions.has(triggeringChildId)) {
        this.childSessions.set(triggeringChildId, { title: triggeringChildId.slice(0, 12), status: 'running' });
        this.log(`child:placeholder ${triggeringChildId}`);
      }
    } finally {
      this.childrenResolvePending = false;
    }
  }

  private extractShortTarget(tool: string, input: Record<string, unknown>): string {
    if (tool === 'bash') {
      const cmd = (input.command as string) ?? (input.description as string) ?? '';
      return cmd.slice(0, 40);
    }
    const filePath = (input.filePath ?? input.file_path ?? input.path ?? input.pattern ?? '') as string;
    if (filePath) {
      const parts = filePath.split('/');
      return parts[parts.length - 1] || filePath.slice(0, 40);
    }
    return '';
  }

  async attach(): Promise<void> {
    this.status = 'running';
    await this.subscribeToEvents();
    this.log('sse:connect (attach)');
    this.resetPromptTimer('attach');
  }

  async start(prompt: string): Promise<void> {
    this.status = 'starting';
    const sdk = this.client as unknown as SdkClient;

    if (!this.sessionId) {
      const res = await sdk.session.create({
        title: prompt.slice(0, 100),
        directory: this.cwd,
      });
      this.sessionId = res.data?.id ?? res.id ?? null;
    }

    await this.subscribeToEvents();
    this.log('sse:connect');

    this.promptsSent++;
    this.sendPrompt(sdk, prompt);
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.sessionId) throw new Error('No active session');
    const sdk = this.client as unknown as SdkClient;

    // Re-subscribe if SSE was lost (stream ended or aborted)
    if (!this.sseAlive) {
      await this.subscribeToEvents();
      this.log('sse:connect');
    }

    this.promptsSent++;
    this.status = 'starting';
    this.sendPrompt(sdk, content);
  }

  private sendPrompt(sdk: SdkClient, content: string): void {
    this.log(`prompt:send length=${content.length}`);
    this.resetPromptTimer('prompt:send');

    void (async () => {
      try {
        await sdk.session.prompt({
          sessionID: this.sessionId!,
          parts: [{ type: 'text', text: content }],
          model: { providerID: this.providerID, modelID: this.modelID },
          ...(this.variant !== undefined ? { variant: this.variant } : {}),
          directory: this.cwd,
          tools: { question: false },
        });
        this.log(`prompt:resolved (status=${this._status})`);
        this.clearPromptTimer('prompt:resolved');
        this.idleFallbackTimer = setTimeout(() => {
          if (this.status === 'running' || this.status === 'starting') {
            this.log(
              `idle:fallback — no session.idle within 5s of prompt:resolved (status=${this._status}, turns=${this.turnsCompleted})`,
            );
            this.turnsCompleted++;
            this.status = 'completed';
            this.emit('message', {
              type: 'turn_end',
              role: 'system',
              content: '',
              meta: {
                subtype: 'success',
                totalCostUsd: this.turnCost,
                turnNumber: this.turnsCompleted,
              },
              usage: this.turnTokens
                ? {
                    inputTokens: this.turnTokens.input,
                    outputTokens: this.turnTokens.output,
                    cacheRead: this.turnTokens.cacheRead,
                    cacheWrite: this.turnTokens.cacheWrite,
                  }
                : undefined,
              timestamp: Date.now(),
            } satisfies AgentMessage);
            this.turnCost = 0;
            this.turnTokens = null;
          }
        }, 5_000);
      } catch (err) {
        if (this.status === 'stopped') return;
        this.log(`prompt:error (status=${this._status}) ${String(err)}`);
        this.clearPromptTimer('prompt:error');
        this.emit('message', {
          type: 'error',
          role: 'system',
          content: `Prompt failed: ${String(err)}`,
          timestamp: Date.now(),
        } satisfies AgentMessage);
        this.status = 'errored';
        this.emit('exit');
      }
    })();
  }

  updateModel(model: string, thinkingLevel: string): void {
    const resolved = resolveModel(this.providerID, model, thinkingLevel as 'off' | 'low' | 'medium' | 'high');
    this.modelID = resolved.modelID;
    this.variant = resolved.variant;
  }

  async kill(): Promise<void> {
    this.clearPromptTimer('kill');
    this.clearIdleFallbackTimer();
    this.clearStopRetry();
    if (!this.sessionId) return;
    const sdk = this.client as unknown as SdkClient;

    // Disconnect SSE before aborting so the session.error event doesn't surface
    this.sseCleanup?.();
    this.abortController?.abort();
    this.status = 'stopped';

    try {
      this.log(`kill (status=${this._status}, turns=${this.turnsCompleted})`);
      await sdk.session.abort({ sessionID: this.sessionId });
    } catch (err) {
      this.log('kill:error ' + String(err));
    }

    this.emit('exit');
  }

  /**
   * Request a graceful stop: send abort but keep SSE connected so we see the
   * session.idle confirmation. Retries the abort every 1s until idle arrives
   * or a 30s hard timeout forces a kill.
   */
  requestStop(): void {
    if (this._stopRequested) {
      // Already stopping — send another abort but don't re-setup
      this.sendAbort();
      return;
    }
    this._stopRequested = true;
    this.clearPromptTimer('requestStop');
    this.clearIdleFallbackTimer();
    this.log(`requestStop (status=${this._status}, turns=${this.turnsCompleted})`);

    // First abort attempt
    this.sendAbort();

    // Retry every 1s
    this.stopRetryInterval = setInterval(() => this.sendAbort(), 1_000);

    // Hard timeout: if session doesn't become idle within 30s, force kill
    setTimeout(() => {
      if (!this._stopRequested) return;
      this.log('requestStop:timeout — force killing');
      this.clearStopRetry();
      void this.kill();
    }, OpenCodeSession.STOP_TIMEOUT_MS);
  }

  private sendAbort(): void {
    if (!this.sessionId) return;
    const sdk = this.client as unknown as SdkClient;
    this.log('abort:send');
    sdk.session.abort({ sessionID: this.sessionId }).catch((err) => {
      this.log('abort:error ' + String(err));
    });
  }

  private clearStopRetry(): void {
    this._stopRequested = false;
    if (this.stopRetryInterval) {
      clearInterval(this.stopRetryInterval);
      this.stopRetryInterval = null;
    }
  }

  async waitForReady(): Promise<void> {
    if (this.sessionId) return;

    const start = Date.now();
    while (!this.sessionId && Date.now() - start < 30_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.sessionId) throw new Error('Session did not become ready within 30s');
  }

  private subscribeToEvents(): Promise<void> {
    const sdk = this.client as unknown as SdkClient;
    this.abortController?.abort(); // tear down previous SSE stream before reconnecting
    this.abortController = new AbortController();
    this.sseAlive = true;

    return new Promise<void>((resolveConnected) => {
      let resolved = false;

      const subscribe = async () => {
        try {
          const events = await sdk.event.subscribe({ directory: this.cwd }, { signal: this.abortController!.signal });

          // Resolve immediately once SSE connection is established
          // Don't wait for first event — that would deadlock if no other sessions are active
          if (!resolved) {
            resolved = true;
            resolveConnected();
          }

          for await (const event of events.stream) {
            if (this.abortController?.signal.aborted) break;

            // Auto-approve ALL permission requests (Orchestrel runs in full-trust mode)
            // Must run before session filter so subagent permissions are also approved
            if (event.type === 'permission.asked' || event.type === 'permission.updated') {
              const perm = event.properties as { id?: string; sessionID?: string; type?: string; title?: string };
              if (perm.id) {
                this.log(`permission:approve ${perm.id} type=${perm.type}`);
                // Permission events indicate active agent work — reset timeout
                if (this.promptTimer) this.resetPromptTimer('permission');
                sdk.permission
                  .reply({ requestID: perm.id, reply: 'always' })
                  .then(() => {
                    this.log(`permission:approved ${perm.id}`);
                  })
                  .catch((err) => this.log('permission:error ' + String(err)));
              }
              continue;
            }

            // Extract session ID — different event types carry it in different places
            // session.updated: info.id | message.part.updated: part.sessionID | others: sessionID
            const props = event.properties as {
              sessionID?: string;
              part?: { sessionID?: string };
              info?: { sessionID?: string; id?: string };
            };
            const sessionID = props.sessionID ?? props.part?.sessionID ?? props.info?.sessionID ?? props.info?.id;

            // Log every SSE event with full payload for traceability
            this.log(
              `sse:event ${JSON.stringify({ type: event.type, sid: sessionID ?? 'none', timer: this.promptTimer ? 'active' : 'null', props: event.properties })}`,
            );

            // Any event carrying our session ID = session is alive, reset timer
            // This catches message.part.delta, step-start, empty reasoning, etc.
            // that normalizeOpenCodeEvent() may not recognize
            if (sessionID === this.sessionId && this.promptTimer) {
              this.resetPromptTimer(`sse:${event.type}`);
            }
            // Also kill the idle fallback — session is still producing events
            if (sessionID === this.sessionId && this.idleFallbackTimer) {
              this.clearIdleFallbackTimer();
            }

            // Child session event handling
            if (sessionID && sessionID !== this.sessionId) {
              // Register child sessions from session.created (carries parentID)
              if (event.type === 'session.created') {
                const info = (event.properties as { info?: { parentID?: string; title?: string } }).info;
                if (info?.parentID === this.sessionId && !this.childSessions.has(sessionID)) {
                  this.childSessions.set(sessionID, { title: info.title ?? sessionID.slice(0, 12), status: 'running' });
                  this.log(`child:registered ${sessionID} title="${(info.title ?? '').slice(0, 60)}"`);
                }
              }

              // Any child session event = parent is still alive waiting for subagent
              if (this.promptTimer && this.childSessions.has(sessionID)) {
                this.resetPromptTimer('child:activity');
              }

              // session.idle for a child = subagent completed
              if (event.type === 'session.idle') {
                const child = this.childSessions.get(sessionID);
                if (child) {
                  child.status = 'idle';
                  this.logChild(sessionID, 'idle');
                  this.emit('message', {
                    type: 'subagent',
                    role: 'system',
                    content: '',
                    meta: { subtype: 'completed', childSessionId: sessionID, title: child.title },
                    timestamp: Date.now(),
                  } satisfies AgentMessage);
                }
                continue;
              }

              // Child retry — log only, don't forward
              if (event.type === 'session.status') {
                const { status } = event.properties as {
                  status?: { type?: string; attempt?: number; next?: number; message?: string };
                };
                if (status?.type === 'retry') {
                  this.logChild(sessionID, `retry attempt=${status.attempt} next=${status.next}ms`);
                }
                continue;
              }

              // Child tool activity — only forward running state
              if (event.type === 'message.part.updated') {
                const part = (
                  event.properties as {
                    part?: {
                      type?: string;
                      tool?: string;
                      state?: { status?: string; input?: Record<string, unknown> };
                    };
                  }
                ).part;
                if (part?.type === 'tool' && part.state?.status === 'running' && part.tool) {
                  // Resolve child session info if unknown
                  if (!this.childSessions.has(sessionID)) {
                    await this.resolveChildren(sessionID);
                  }
                  const child = this.childSessions.get(sessionID);
                  if (!child) {
                    continue;
                  } // Not our child — truly skip

                  const target = this.extractShortTarget(part.tool, part.state.input ?? {});
                  this.logChild(sessionID, `tool:${part.tool} → ${target} (running)`);
                  this.emit('message', {
                    type: 'subagent',
                    role: 'system',
                    content: '',
                    meta: {
                      subtype: 'activity',
                      childSessionId: sessionID,
                      title: child.title,
                      tool: part.tool,
                      target,
                      status: 'running',
                    },
                    timestamp: Date.now(),
                  } satisfies AgentMessage);
                }
                continue;
              }

              // All other child events — skip silently
              continue;
            }

            // Track cost and user message IDs from message.updated events
            if (event.type === 'message.updated') {
              const info = event.properties.info as {
                role?: string;
                cost?: number;
                id?: string;
                messageID?: string;
                tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
              };
              if (info?.role === 'assistant') {
                if (typeof info.cost === 'number') {
                  this.turnCost = info.cost;
                }
                const tokens = info.tokens;
                if (tokens) {
                  this.turnTokens = {
                    input: tokens.input ?? 0,
                    output: tokens.output ?? 0,
                    cacheRead: tokens.cache?.read ?? 0,
                    cacheWrite: tokens.cache?.write ?? 0,
                  };
                }
              }
              if (info?.role === 'user') {
                const msgId = info.id ?? info.messageID;
                if (msgId) this.userMessageIds.add(msgId);
              }
            }

            // Skip message.part.updated events that belong to user messages
            if (event.type === 'message.part.updated') {
              const part = (event.properties as { part?: { messageID?: string } }).part;
              if (part?.messageID && this.userMessageIds.has(part.messageID)) continue;
            }

            const msg = normalizeOpenCodeEvent(event);
            if (msg) {
              this.emit('message', msg);
            }

            // session.status busy = opencode started processing a turn
            if (event.type === 'session.status') {
              const { status } = event.properties as {
                sessionID?: string;
                status?: { type?: string; attempt?: number; next?: number; message?: string };
              };
              if (status?.type === 'busy') {
                if (this.status !== 'running') {
                  this.status = 'running';
                  this.emit('message', {
                    type: 'system',
                    role: 'system',
                    content: '',
                    meta: { subtype: 'init', model: this.modelID, turn: this.promptsSent },
                    timestamp: Date.now(),
                  } satisfies AgentMessage);
                }
              }
              if (status?.type === 'retry') {
                this.status = 'retry';
                this.log(`retry attempt=${status.attempt} next=${status.next}ms message="${status.message}"`);
                this.emit('message', {
                  type: 'system',
                  role: 'system',
                  content: '',
                  meta: {
                    subtype: 'retry',
                    attempt: status.attempt,
                    message: status.message,
                    nextMs: status.next,
                  },
                  timestamp: Date.now(),
                } satisfies AgentMessage);
              }
            }

            // session.idle = assistant finished one response cycle (turn complete)
            // Session stays alive for follow-up messages — don't break or emit exit
            if (event.type === 'session.idle') {
              this.log(
                `session:idle (turns=${this.turnsCompleted + 1}, prompts=${this.promptsSent}, stopRequested=${this._stopRequested})`,
              );
              this.clearPromptTimer('session.idle');
              this.clearIdleFallbackTimer();
              const sid = (event.properties as { sessionID?: string }).sessionID;
              if (sid && sid !== this.sessionId) continue;

              // Stop was requested — abort confirmed, clean up
              if (this._stopRequested) {
                this.clearStopRetry();
                this.status = 'stopped';
                this.emit('exit');
                break;
              }

              this.turnsCompleted++;
              this.status = 'completed';
              this.emit('message', {
                type: 'turn_end',
                role: 'system',
                content: '',
                meta: {
                  subtype: 'success',
                  totalCostUsd: this.turnCost,
                  turnNumber: this.turnsCompleted,
                },
                usage: this.turnTokens
                  ? {
                      inputTokens: this.turnTokens.input,
                      outputTokens: this.turnTokens.output,
                      cacheRead: this.turnTokens.cacheRead,
                      cacheWrite: this.turnTokens.cacheWrite,
                    }
                  : undefined,
                timestamp: Date.now(),
              } satisfies AgentMessage);
              this.turnCost = 0;
              this.turnTokens = null;
            }

            if (event.type === 'session.error') {
              const sid = (event.properties as { sessionID?: string }).sessionID;
              if (sid && sid !== this.sessionId) continue;
              // Abort-induced error while stop requested — treat as successful stop
              if (this._stopRequested) {
                this.log('session:error during stop — treating as stopped');
                this.clearStopRetry();
                this.clearPromptTimer('session.error:stop');
                this.clearIdleFallbackTimer();
                this.status = 'stopped';
                this.emit('exit');
                break;
              }
              // Ignore errors caused by our own abort (user hit stop)
              if (this.status === 'stopped') break;
              this.log('session:error ' + JSON.stringify(event.properties));
              this.clearPromptTimer('session.error');
              this.clearIdleFallbackTimer();
              const rawErr = (
                event.properties as {
                  error?: { name?: string; message?: string; data?: { message?: string } } | string;
                }
              ).error;
              const errMsg =
                typeof rawErr === 'string'
                  ? rawErr
                  : (rawErr?.data?.message ?? rawErr?.message ?? rawErr?.name ?? 'Unknown session error');
              this.emit('message', {
                type: 'error',
                role: 'system',
                content: errMsg,
                timestamp: Date.now(),
              } satisfies AgentMessage);
              this.status = 'errored';
              this.emit('exit');
              break;
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            resolveConnected();
          }
          if (this.abortController?.signal.aborted || this.status === 'stopped') return;
          this.log('sse:disconnect reason=' + String(err));
          this.status = 'errored';
          this.emit('message', {
            type: 'error',
            role: 'system',
            content: `SSE stream error: ${err}`,
            timestamp: Date.now(),
          } satisfies AgentMessage);
          this.emit('exit');
        } finally {
          this.sseAlive = false;
          this.clearPromptTimer('sse:ended');
          this.clearIdleFallbackTimer();
          this.log(`sse:ended (status=${this._status}, turns=${this.turnsCompleted}, prompts=${this.promptsSent})`);
          if (this.status !== 'stopped' && this.status !== 'errored' && this.status !== 'completed') {
            this.emit('message', {
              type: 'error',
              role: 'system',
              content: 'SSE stream ended unexpectedly',
              timestamp: Date.now(),
            } satisfies AgentMessage);
            this.status = 'errored';
            this.emit('exit');
          }
        }
      };

      subscribe();
      this.sseCleanup = () => this.abortController?.abort();
    });
  }
}
