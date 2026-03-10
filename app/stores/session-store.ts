import { makeAutoObservable, observable } from 'mobx'
import type { ClaudeMessage, ClaudeStatus, FileRef } from '../../src/shared/ws-protocol'
import type { WsClient } from '../lib/ws-client'

let _ws: WsClient | null = null

export function setSessionStoreWs(ws: WsClient) {
  _ws = ws
}

function ws(): WsClient {
  if (!_ws) throw new Error('WsClient not set')
  return _ws
}

export interface SessionState {
  active: boolean
  status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped'
  sessionId: string | null
  promptsSent: number
  turnsCompleted: number
  liveMessages: ClaudeMessage[]
  history: ClaudeMessage[]
  contextTokens: number
  contextWindow: number
}

function defaultSession(): SessionState {
  return {
    active: false,
    status: 'stopped',
    sessionId: null,
    promptsSent: 0,
    turnsCompleted: 0,
    liveMessages: [],
    history: [],
    contextTokens: 0,
    contextWindow: 200_000,
  }
}

export class SessionStore {
  sessions = observable.map<number, SessionState>()

  constructor() {
    makeAutoObservable(this)
  }

  private getOrCreate(cardId: number): SessionState {
    if (!this.sessions.has(cardId)) {
      this.sessions.set(cardId, defaultSession())
    }
    return this.sessions.get(cardId)!
  }

  getSession(cardId: number): SessionState | undefined {
    return this.sessions.get(cardId)
  }

  // ── Incoming server messages ────────────────────────────────────────────────

  handleClaudeMessage(cardId: number, data: ClaudeMessage) {
    const s = this.getOrCreate(cardId)
    s.liveMessages.push(data)

    // Extract context token usage from result messages
    if (data.type === 'result') {
      const msg = data.message as Record<string, unknown>
      if (typeof msg.usage === 'object' && msg.usage !== null) {
        const usage = msg.usage as Record<string, unknown>
        if (typeof usage.input_tokens === 'number') {
          s.contextTokens = usage.input_tokens
        }
      }
      if (typeof msg.context_window === 'number') {
        s.contextWindow = msg.context_window
      }
    }
  }

  handleClaudeStatus(data: ClaudeStatus) {
    const s = this.getOrCreate(data.cardId)
    s.active = data.active
    s.status = data.status
    s.sessionId = data.sessionId
    s.promptsSent = data.promptsSent
    s.turnsCompleted = data.turnsCompleted

    // Clear live messages when session completes/stops so history takes over
    if (data.status === 'completed' || data.status === 'stopped') {
      s.liveMessages = []
    }
  }

  setHistory(cardId: number, messages: ClaudeMessage[]) {
    const s = this.getOrCreate(cardId)
    s.history = messages
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async startSession(cardId: number, prompt: string): Promise<void> {
    const s = this.getOrCreate(cardId)
    s.active = true
    s.status = 'starting'
    s.liveMessages = []

    const requestId = crypto.randomUUID()
    await ws().mutate({
      type: 'claude:start',
      requestId,
      data: { cardId, prompt },
    })
  }

  async sendMessage(cardId: number, message: string, files?: FileRef[]): Promise<void> {
    const requestId = crypto.randomUUID()
    await ws().mutate({
      type: 'claude:send',
      requestId,
      data: { cardId, message, files },
    })
  }

  async stopSession(cardId: number): Promise<void> {
    const requestId = crypto.randomUUID()
    await ws().mutate({
      type: 'claude:stop',
      requestId,
      data: { cardId },
    })
  }

  async requestStatus(cardId: number): Promise<void> {
    const requestId = crypto.randomUUID()
    await ws().mutate({
      type: 'claude:status',
      requestId,
      data: { cardId },
    })
  }

  async loadHistory(cardId: number, sessionId: string): Promise<void> {
    const requestId = crypto.randomUUID()
    await ws().mutate({
      type: 'session:load',
      requestId,
      data: { cardId, sessionId },
    })
    // History arrives via session:history server message, routed to setHistory()
  }
}
