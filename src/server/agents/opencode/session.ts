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
  }
  event: {
    subscribe(opts: { signal: AbortSignal; headers: Record<string, string> }): Promise<{ stream: AsyncIterable<{ type: string; properties: Record<string, unknown> }> }>
  }
}

export class OpenCodeSession extends AgentSession {
  sessionId: string | null = null
  status: SessionStatus = 'starting'
  promptsSent = 0
  turnsCompleted = 0

  private abortController: AbortController | null = null
  private sseCleanup: (() => void) | null = null
  private sseAlive = false
  private turnCost = 0
  private userMessageIds = new Set<string>()

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

  async start(prompt: string): Promise<void> {
    this.status = 'running'
    const sdk = this.client as unknown as SdkClient

    if (!this.sessionId) {
      const res = await sdk.session.create({
        body: { title: prompt.slice(0, 100) },
        query: { directory: this.cwd },
      })
      this.sessionId = res.data?.id ?? res.id ?? null
    }

    this.emit('message', {
      type: 'system',
      role: 'system',
      content: '',
      meta: { subtype: 'init', model: this.modelID },
      timestamp: Date.now(),
    } satisfies AgentMessage)

    await this.subscribeToEvents()

    this.promptsSent++
    await sdk.session.promptAsync({
      path: { id: this.sessionId! },
      body: {
        parts: [{ type: 'text', text: prompt }],
        model: { providerID: this.providerID, modelID: this.modelID },
        ...(this.variant !== undefined ? { variant: this.variant } : {}),
      },
      query: { directory: this.cwd },
    })
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.sessionId) throw new Error('No active session')
    const sdk = this.client as unknown as SdkClient

    // Re-subscribe if SSE was lost (stream ended or aborted)
    if (!this.sseAlive) {
      await this.subscribeToEvents()
    }

    this.promptsSent++
    this.status = 'running'

    await sdk.session.promptAsync({
      path: { id: this.sessionId },
      body: {
        parts: [{ type: 'text', text: content }],
        model: { providerID: this.providerID, modelID: this.modelID },
        ...(this.variant !== undefined ? { variant: this.variant } : {}),
      },
      query: { directory: this.cwd },
    })
  }

  updateModel(model: string, thinkingLevel: string): void {
    const resolved = resolveModel(
      this.providerID,
      model as 'sonnet' | 'opus',
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
      await sdk.session.abort({ path: { id: this.sessionId } })
    } catch (err) {
      console.error(`[opencode-session:${this.sessionId}] abort error:`, err)
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
            console.log(`[opencode-session:${this.sessionId}] SSE event #${eventCount}: ${event.type}`)

            if (this.abortController?.signal.aborted) break

            // Filter events to this session — parts carry sessionID directly
            const props = event.properties as { sessionID?: string; part?: { sessionID?: string }; info?: { sessionID?: string } }
            const sessionID =
              props.sessionID ??
              props.part?.sessionID ??
              props.info?.sessionID
            if (sessionID && sessionID !== this.sessionId) {
              console.log(`[opencode-session:${this.sessionId}] skipping event for session ${sessionID}`)
              continue
            }

            // Track cost and user message IDs from message.updated events
            if (event.type === 'message.updated') {
              const info = event.properties.info as { role?: string; cost?: number; id?: string; messageID?: string }
              if (info?.role === 'assistant' && typeof info.cost === 'number') {
                this.turnCost = info.cost
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

            // session.idle = assistant finished one response cycle (turn complete)
            // Session stays alive for follow-up messages — don't break or emit exit
            if (event.type === 'session.idle') {
              console.log(`[opencode-session:${this.sessionId}] session.idle received!`)
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
                timestamp: Date.now(),
              } satisfies AgentMessage)
              this.turnCost = 0
            }

            if (event.type === 'session.error') {
              const sid = (event.properties as { sessionID?: string }).sessionID
              if (sid && sid !== this.sessionId) continue
              // Ignore errors caused by our own abort (user hit stop)
              if (this.status === 'stopped') break
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
          console.error(`[opencode-session:${this.sessionId}] SSE error:`, err)
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
