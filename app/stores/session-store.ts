import { makeAutoObservable, observable, runInAction } from 'mobx'
import type { ClaudeMessage, ClaudeStatus, FileRef } from '../../src/shared/ws-protocol'
import type { WsClient } from '../lib/ws-client'
import { uuid } from '../lib/utils'
import { contentHashSync } from '../lib/content-hash'

let _ws: WsClient | null = null

export function setSessionStoreWs(ws: WsClient) {
  _ws = ws
}

function ws(): WsClient {
  if (!_ws) throw new Error('WsClient not set')
  return _ws
}

export interface ConversationRow {
  id: string                              // content hash for dedup
  type: 'user' | 'assistant' | 'result' | 'system'
  message: Record<string, unknown>
  isSidechain?: boolean
  ts?: string
}

export interface SessionState {
  active: boolean
  status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped'
  sessionId: string | null
  promptsSent: number
  turnsCompleted: number
  conversation: ConversationRow[]
  conversationIds: Set<string>            // O(1) dedup lookup
  historyLoaded: boolean                  // true after first history load
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
    conversation: [],
    conversationIds: new Set(),
    historyLoaded: false,
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

  /**
   * Ingest a single message (live stream or optimistic send).
   * Hashes content for dedup — if already in conversation, skips silently.
   */
  ingest(cardId: number, msg: ClaudeMessage): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId)
      const id = contentHashSync(msg.type, msg.message)

      if (s.conversationIds.has(id)) return // dedup

      const row: ConversationRow = {
        id,
        type: msg.type as ConversationRow['type'],
        message: msg.message,
        ...(msg.isSidechain !== undefined && { isSidechain: msg.isSidechain }),
        ...(msg.ts !== undefined && { ts: msg.ts }),
      }

      s.conversation.push(row)
      s.conversationIds.add(id)

      // Extract context token usage from result messages
      if (msg.type === 'result') {
        const m = msg.message
        if (typeof m.usage === 'object' && m.usage !== null) {
          const usage = m.usage as Record<string, unknown>
          if (typeof usage.input_tokens === 'number') {
            s.contextTokens = usage.input_tokens
          }
        }
        if (typeof m.context_window === 'number') {
          s.contextWindow = m.context_window
        }
      }
    })
  }

  /**
   * Ingest a batch of messages (history load from JSONL).
   * Prepends any messages not already in conversation (history comes first).
   * Only runs once per card (guards with historyLoaded flag).
   */
  ingestBatch(cardId: number, messages: ClaudeMessage[]): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId)

      if (s.historyLoaded) return

      const newRows: ConversationRow[] = []

      for (const msg of messages) {
        const id = contentHashSync(msg.type, msg.message)
        if (s.conversationIds.has(id)) continue

        newRows.push({
          id,
          type: msg.type as ConversationRow['type'],
          message: msg.message,
          ...(msg.isSidechain !== undefined && { isSidechain: msg.isSidechain }),
          ...(msg.ts !== undefined && { ts: msg.ts }),
        })
        s.conversationIds.add(id)
      }

      if (newRows.length > 0) {
        // Prepend history before any live messages
        s.conversation.unshift(...newRows)
      }

      s.historyLoaded = true
    })
  }

  /**
   * Clear conversation state (card switch, session reset).
   */
  clearConversation(cardId: number): void {
    const s = this.sessions.get(cardId)
    if (!s) return
    s.conversation.splice(0)
    s.conversationIds.clear()
    s.historyLoaded = false
    s.contextTokens = 0
    s.contextWindow = 200_000
  }

  handleClaudeStatus(data: ClaudeStatus) {
    runInAction(() => {
      const s = this.getOrCreate(data.cardId)
      s.active = data.active
      s.status = data.status
      s.sessionId = data.sessionId
      s.promptsSent = data.promptsSent
      s.turnsCompleted = data.turnsCompleted
    })
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async startSession(cardId: number, prompt: string): Promise<void> {
    const s = this.getOrCreate(cardId)
    s.active = true
    s.status = 'starting'

    // Optimistic: add user message to conversation immediately
    this.ingest(cardId, {
      type: 'user',
      message: { role: 'user', content: prompt },
    })

    const requestId = uuid()
    await ws().mutate({
      type: 'claude:start',
      requestId,
      data: { cardId, prompt },
    })
  }

  async sendMessage(cardId: number, message: string, files?: FileRef[]): Promise<void> {
    // Only add optimistic message when no files (file prompts get augmented server-side)
    if (!files?.length) {
      this.ingest(cardId, {
        type: 'user',
        message: { role: 'user', content: message },
      })
    }

    const requestId = uuid()
    await ws().mutate({
      type: 'claude:send',
      requestId,
      data: { cardId, message, files },
    })
  }

  async stopSession(cardId: number): Promise<void> {
    const requestId = uuid()
    await ws().mutate({
      type: 'claude:stop',
      requestId,
      data: { cardId },
    })
  }

  async requestStatus(cardId: number): Promise<void> {
    const requestId = uuid()
    await ws().mutate({
      type: 'claude:status',
      requestId,
      data: { cardId },
    })
  }

  async loadHistory(cardId: number, sessionId: string): Promise<void> {
    const requestId = uuid()
    await ws().mutate({
      type: 'session:load',
      requestId,
      data: { cardId, sessionId },
    })
    // History arrives via session:history server message, routed to ingestBatch()
  }
}
