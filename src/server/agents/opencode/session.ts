import { AgentSession } from '../types'
import type { SessionStatus, AgentMessage } from '../types'
import { normalizeOpenCodeEvent } from './messages'
import { resolveModelID } from './models'

export class OpenCodeSession extends AgentSession {
  sessionId: string | null = null
  status: SessionStatus = 'starting'
  promptsSent = 0
  turnsCompleted = 0

  private abortController: AbortController | null = null
  private sseCleanup: (() => void) | null = null

  constructor(
    private client: unknown,
    private cwd: string,
    private providerID: string,
    private modelID: string,
    private resumeSessionId?: string,
  ) {
    super()
    if (resumeSessionId) {
      this.sessionId = resumeSessionId
    }
  }

  async start(prompt: string): Promise<void> {
    this.status = 'running'
    const sdk = this.client as any

    if (!this.sessionId) {
      const res = await sdk.session.create({
        body: { title: prompt.slice(0, 100) },
        query: { directory: this.cwd },
      })
      this.sessionId = res.data?.id ?? res.id
    }

    this.subscribeToEvents()

    this.promptsSent++
    await sdk.session.prompt({
      path: { id: this.sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        model: { providerID: this.providerID, modelID: this.modelID },
      },
      query: { directory: this.cwd },
    })
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.sessionId) throw new Error('No active session')
    const sdk = this.client as any

    this.promptsSent++
    this.status = 'running'

    await sdk.session.prompt({
      path: { id: this.sessionId },
      body: {
        parts: [{ type: 'text', text: content }],
        model: { providerID: this.providerID, modelID: this.modelID },
      },
      query: { directory: this.cwd },
    })
  }

  updateModel(model: string, thinkingLevel: string): void {
    this.modelID = resolveModelID(
      model as 'sonnet' | 'opus',
      thinkingLevel as 'off' | 'low' | 'medium' | 'high',
    )
  }

  async kill(): Promise<void> {
    if (!this.sessionId) return
    const sdk = this.client as any

    try {
      await sdk.session.abort({ path: { id: this.sessionId } })
    } catch (err) {
      console.error(`[opencode-session:${this.sessionId}] abort error:`, err)
    }

    this.sseCleanup?.()
    this.abortController?.abort()
    this.status = 'stopped'
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

  private subscribeToEvents(): void {
    const sdk = this.client as any
    this.abortController = new AbortController()

    const subscribe = async () => {
      try {
        const events = await sdk.event.subscribe({
          signal: this.abortController!.signal,
        })

        for await (const event of events.stream) {
          if (this.abortController?.signal.aborted) break

          const sessionId = (event.properties as any)?.sessionId ?? (event.properties as any)?.session_id
          if (sessionId && sessionId !== this.sessionId) continue

          const msg = normalizeOpenCodeEvent(event)
          if (msg) this.emit('message', msg)

          if (event.type === 'message.completed') {
            const role = (event.properties as any)?.role
            if (role === 'assistant') {
              this.turnsCompleted++
              this.emit('message', {
                type: 'turn_end',
                role: 'system',
                content: '',
                timestamp: Date.now(),
              } satisfies AgentMessage)
            }
          }

          if (event.type === 'session.completed' || event.type === 'session.error') {
            this.status = event.type === 'session.error' ? 'errored' : 'completed'
            this.emit('exit')
            break
          }
        }
      } catch (err) {
        if (this.abortController?.signal.aborted) return
        console.error(`[opencode-session:${this.sessionId}] SSE error:`, err)
        this.status = 'errored'
        this.emit('message', {
          type: 'error',
          role: 'system',
          content: `SSE stream error: ${err}`,
          timestamp: Date.now(),
        } satisfies AgentMessage)
        this.emit('exit')
      }
    }

    subscribe()
    this.sseCleanup = () => this.abortController?.abort()
  }
}
