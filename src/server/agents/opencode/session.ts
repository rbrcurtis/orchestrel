import { AgentSession } from '../types'
import type { SessionStatus, AgentMessage } from '../types'
import { normalizeOpenCodeEvent } from './messages'
import { resolveModel } from './models'

interface SdkClient {
  session: {
    create(opts: { body: { title: string }; query: { directory: string } }): Promise<{ data?: { id: string }; id?: string }>
    prompt(opts: { path: { id: string }; body: { parts: { type: string; text: string }[]; model: { providerID: string; modelID: string }; variant?: string }; query: { directory: string } }): Promise<void>
    promptAsync(opts: { path: { id: string }; body: { parts: { type: string; text: string }[]; model: { providerID: string; modelID: string }; variant?: string }; query: { directory: string } }): Promise<void>
    abort(opts: { path: { id: string } }): Promise<void>
    children(opts: { path: { id: string } }): Promise<Array<{ id: string; title: string; parentID?: string }>>
  }
  event: {
    subscribe(opts: { signal: AbortSignal; headers: Record<string, string> }): Promise<{ stream: AsyncIterable<{ type: string; properties: Record<string, unknown> }> }>
  }
  postSessionIdPermissionsPermissionId(opts: { path: { id: string; permissionID: string }; body: { response: 'once' | 'always' | 'reject' } }): Promise<unknown>
}

export class OpenCodeSession extends AgentSession {
  sessionId: string | null = null
  private _status: SessionStatus = 'starting'
  promptsSent = 0
  turnsCompleted = 0

  private abortController: AbortController | null = null
  private sseCleanup: (() => void) | null = null
  private sseAlive = false
  private turnCost = 0
  private turnTokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null
  private userMessageIds = new Set<string>()
  private childSessions = new Map<string, { title: string; status: string }>()
  private childrenResolvePending = false

  constructor(
    private client: unknown,
    private cwd: string,
    private providerID: string,
    private modelID: string,
    private variant: string | undefined,
    private resumeSessionId?: string,
  ) {
    super()
    if (resumeSessionId) {
      this.sessionId = resumeSessionId
    }
  }

  override get status(): SessionStatus { return this._status }
  override set status(val: SessionStatus) {
    if (val !== this._status) {
      this.log(`status: ${this._status} → ${val}`)
      this._status = val
    }
  }

  private log(msg: string): void {
    console.log(`[session:${this.sessionId ?? 'pending'}] ${msg}`)
  }

  private logChild(childId: string, msg: string): void {
    console.log(`[session:${this.sessionId ?? 'pending'}:child:${childId}] ${msg}`)
  }

  private async resolveChildren(triggeringChildId?: string): Promise<void> {
    if (this.childrenResolvePending || !this.sessionId) {
      // Still insert placeholder so this child isn't permanently unknown
      if (triggeringChildId && !this.childSessions.has(triggeringChildId)) {
        this.childSessions.set(triggeringChildId, { title: triggeringChildId.slice(0, 12), status: 'running' })
        this.log(`child:placeholder ${triggeringChildId}`)
      }
      return
    }
    this.childrenResolvePending = true
    try {
      const sdk = this.client as unknown as SdkClient
      const res = await sdk.session.children({ path: { id: this.sessionId } })
      // SDK may wrap response in { data: [...] } or return bare array
      const children = Array.isArray(res) ? res : ((res as Record<string, unknown>).data as Array<{ id: string; title: string; parentID?: string }>) ?? []
      if (!Array.isArray(children)) {
        this.log(`child:resolve-unexpected response=${JSON.stringify(res).slice(0, 200)}`)
        return
      }
      for (const child of children) {
        if (!this.childSessions.has(child.id)) {
          this.childSessions.set(child.id, { title: child.title, status: 'running' })
          this.log(`child:discovered ${child.id} title="${child.title.slice(0, 60)}"`)
        }
      }
    } catch (err) {
      this.log(`child:resolve-error ${err}`)
      // Use child session ID as placeholder title — retry resolution on next event
      if (triggeringChildId && !this.childSessions.has(triggeringChildId)) {
        this.childSessions.set(triggeringChildId, { title: triggeringChildId.slice(0, 12), status: 'running' })
        this.log(`child:placeholder ${triggeringChildId}`)
      }
    } finally {
      this.childrenResolvePending = false
    }
  }

  private extractShortTarget(tool: string, input: Record<string, unknown>): string {
    if (tool === 'bash') {
      const cmd = (input.command as string) ?? (input.description as string) ?? ''
      return cmd.slice(0, 40)
    }
    const filePath = (input.filePath ?? input.file_path ?? input.path ?? input.pattern ?? '') as string
    if (filePath) {
      const parts = filePath.split('/')
      return parts[parts.length - 1] || filePath.slice(0, 40)
    }
    return ''
  }

  async start(prompt: string): Promise<void> {
    this.status = 'starting'
    const sdk = this.client as unknown as SdkClient

    if (!this.sessionId) {
      const res = await sdk.session.create({
        body: { title: prompt.slice(0, 100) },
        query: { directory: this.cwd },
      })
      this.sessionId = res.data?.id ?? res.id ?? null
    }

    await this.subscribeToEvents()
    this.log('sse:connect')

    this.promptsSent++
    this.log('prompt:send length=' + prompt.length)
    await sdk.session.promptAsync({
      path: { id: this.sessionId! },
      body: {
        parts: [{ type: 'text', text: prompt }],
        model: { providerID: this.providerID, modelID: this.modelID },
        ...(this.variant !== undefined ? { variant: this.variant } : {}),
      },
      query: { directory: this.cwd },
    })
    this.log('prompt:ack')
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.sessionId) throw new Error('No active session')
    const sdk = this.client as unknown as SdkClient

    // Re-subscribe if SSE was lost (stream ended or aborted)
    if (!this.sseAlive) {
      await this.subscribeToEvents()
      this.log('sse:connect')
    }

    this.promptsSent++
    this.status = 'starting'

    this.log('prompt:send length=' + content.length)
    await sdk.session.promptAsync({
      path: { id: this.sessionId },
      body: {
        parts: [{ type: 'text', text: content }],
        model: { providerID: this.providerID, modelID: this.modelID },
        ...(this.variant !== undefined ? { variant: this.variant } : {}),
      },
      query: { directory: this.cwd },
    })
    this.log('prompt:ack')
  }

  updateModel(model: string, thinkingLevel: string): void {
    const resolved = resolveModel(
      this.providerID,
      model as 'sonnet' | 'opus' | 'auto',
      thinkingLevel as 'off' | 'low' | 'medium' | 'high',
    )
    this.modelID = resolved.modelID
    this.variant = resolved.variant
  }

  async kill(): Promise<void> {
    if (!this.sessionId) return
    const sdk = this.client as unknown as SdkClient

    // Disconnect SSE before aborting so the session.error event doesn't surface
    this.sseCleanup?.()
    this.abortController?.abort()
    this.status = 'stopped'

    try {
      this.log('kill')
      await sdk.session.abort({ path: { id: this.sessionId } })
    } catch (err) {
      this.log('kill:error ' + String(err))
    }

    this.emit('exit')
  }

  async waitForReady(): Promise<void> {
    if (this.sessionId) return

    const start = Date.now()
    while (!this.sessionId && Date.now() - start < 30_000) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!this.sessionId) throw new Error('Session did not become ready within 30s')
  }

  private subscribeToEvents(): Promise<void> {
    const sdk = this.client as unknown as SdkClient
    this.abortController = new AbortController()
    this.sseAlive = true

    return new Promise<void>((resolveConnected) => {
      let resolved = false

      const subscribe = async () => {
        try {
          const events = await sdk.event.subscribe({
            signal: this.abortController!.signal,
            headers: { 'x-opencode-directory': encodeURIComponent(this.cwd) },
          })

          // Resolve immediately once SSE connection is established
          // Don't wait for first event — that would deadlock if no other sessions are active
          if (!resolved) {
            resolved = true
            resolveConnected()
          }

          let eventCount = 0
          for await (const event of events.stream) {
            eventCount++

            if (this.abortController?.signal.aborted) break

            // Auto-approve ALL permission requests (Dispatcher runs in full-trust mode)
            // Must run before session filter so subagent permissions are also approved
            if (event.type === 'permission.asked' || event.type === 'permission.updated') {
              const perm = event.properties as { id?: string; sessionID?: string; type?: string; title?: string }
              const permSessionId = perm.sessionID ?? this.sessionId!
              if (perm.id) {
                this.log(`permission:approve ${perm.id} type=${perm.type}`)
                sdk.postSessionIdPermissionsPermissionId({
                  path: { id: permSessionId, permissionID: perm.id },
                  body: { response: 'always' },
                }).then(() => {
                  this.log(`permission:approved ${perm.id}`)
                }).catch(err => this.log('permission:error ' + String(err)))
              }
              continue
            }

            // Filter events to this session — parts carry sessionID directly
            const props = event.properties as { sessionID?: string; part?: { sessionID?: string }; info?: { sessionID?: string } }
            const sessionID =
              props.sessionID ??
              props.part?.sessionID ??
              props.info?.sessionID
            // Child session event handling
            if (sessionID && sessionID !== this.sessionId) {
              // session.idle for a child = subagent completed
              if (event.type === 'session.idle') {
                const child = this.childSessions.get(sessionID)
                if (child) {
                  child.status = 'idle'
                  this.logChild(sessionID, 'idle')
                  this.emit('message', {
                    type: 'subagent',
                    role: 'system',
                    content: '',
                    meta: { subtype: 'completed', childSessionId: sessionID, title: child.title },
                    timestamp: Date.now(),
                  } satisfies AgentMessage)
                }
                continue
              }

              // Child retry — log only, don't forward
              if (event.type === 'session.status') {
                const { status } = event.properties as { status?: { type?: string; attempt?: number; next?: number; message?: string } }
                if (status?.type === 'retry') {
                  this.logChild(sessionID, `retry attempt=${status.attempt} next=${status.next}ms`)
                }
                continue
              }

              // Child tool activity — only forward running state
              if (event.type === 'message.part.updated') {
                const part = (event.properties as { part?: { type?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown> } } }).part
                if (part?.type === 'tool' && part.state?.status === 'running' && part.tool) {
                  // Resolve child session info if unknown
                  if (!this.childSessions.has(sessionID)) {
                    await this.resolveChildren(sessionID)
                  }
                  const child = this.childSessions.get(sessionID)
                  if (!child) { continue } // Not our child — truly skip

                  const target = this.extractShortTarget(part.tool, part.state.input ?? {})
                  this.logChild(sessionID, `tool:${part.tool} → ${target} (running)`)
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
                  } satisfies AgentMessage)
                }
                continue
              }

              // All other child events — skip silently
              continue
            }

            // Track cost and user message IDs from message.updated events
            if (event.type === 'message.updated') {
              const info = event.properties.info as { role?: string; cost?: number; id?: string; messageID?: string; tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } } }
              if (info?.role === 'assistant') {
                if (typeof info.cost === 'number') {
                  this.turnCost = info.cost
                }
                const tokens = info.tokens
                if (tokens) {
                  this.turnTokens = {
                    input: tokens.input ?? 0,
                    output: tokens.output ?? 0,
                    cacheRead: tokens.cache?.read ?? 0,
                    cacheWrite: tokens.cache?.write ?? 0,
                  }
                }
              }
              if (info?.role === 'user') {
                const msgId = info.id ?? info.messageID
                if (msgId) this.userMessageIds.add(msgId)
              }
            }

            // Skip message.part.updated events that belong to user messages
            if (event.type === 'message.part.updated') {
              const part = (event.properties as { part?: { messageID?: string } }).part
              if (part?.messageID && this.userMessageIds.has(part.messageID)) continue
            }

            const msg = normalizeOpenCodeEvent(event)
            if (msg) this.emit('message', msg)

            // session.status busy = opencode started processing a turn
            if (event.type === 'session.status') {
              const { status } = event.properties as { sessionID?: string; status?: { type?: string; attempt?: number; next?: number; message?: string } }
              if (status?.type === 'busy' && this.status !== 'running') {
                this.status = 'running'
                this.emit('message', {
                  type: 'system',
                  role: 'system',
                  content: '',
                  meta: { subtype: 'init', model: this.modelID, turn: this.promptsSent },
                  timestamp: Date.now(),
                } satisfies AgentMessage)
              }
              if (status?.type === 'retry') {
                this.status = 'retry'
                this.log(`retry attempt=${status.attempt} next=${status.next}ms message="${status.message}"`)
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
                } satisfies AgentMessage)
              }
            }

            // session.idle = assistant finished one response cycle (turn complete)
            // Session stays alive for follow-up messages — don't break or emit exit
            if (event.type === 'session.idle') {
              this.log('session:idle')
              const sid = (event.properties as { sessionID?: string }).sessionID
              if (sid && sid !== this.sessionId) continue
              this.turnsCompleted++
              this.status = 'completed'
              this.emit('message', {
                type: 'turn_end',
                role: 'system',
                content: '',
                meta: {
                  subtype: 'success',
                  totalCostUsd: this.turnCost,
                  turnNumber: this.turnsCompleted,
                },
                usage: this.turnTokens ? {
                  inputTokens: this.turnTokens.input,
                  outputTokens: this.turnTokens.output,
                  cacheRead: this.turnTokens.cacheRead,
                  cacheWrite: this.turnTokens.cacheWrite,
                } : undefined,
                timestamp: Date.now(),
              } satisfies AgentMessage)
              this.turnCost = 0
              this.turnTokens = null
            }

            if (event.type === 'session.error') {
              const sid = (event.properties as { sessionID?: string }).sessionID
              if (sid && sid !== this.sessionId) continue
              // Ignore errors caused by our own abort (user hit stop)
              if (this.status === 'stopped') break
              this.log('session:error ' + JSON.stringify(event.properties))
              this.status = 'errored'
              this.emit('exit')
              break
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true
            resolveConnected()
          }
          if (this.abortController?.signal.aborted || this.status === 'stopped') return
          this.log('sse:disconnect reason=' + String(err))
          this.status = 'errored'
          this.emit('message', {
            type: 'error',
            role: 'system',
            content: `SSE stream error: ${err}`,
            timestamp: Date.now(),
          } satisfies AgentMessage)
          this.emit('exit')
        } finally {
          this.sseAlive = false
        }
      }

      subscribe()
      this.sseCleanup = () => this.abortController?.abort()
    })
  }
}
