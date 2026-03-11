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

      // Extract context fill from assistant messages (skip sidechain)
      if (msg.type === 'assistant' && !msg.isSidechain) {
        const m = msg.message
        if (typeof m.usage === 'object' && m.usage !== null) {
          const u = m.usage as Record<string, unknown>
          const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0
          const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0
          const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0
          s.contextTokens = input + cacheCreate + cacheRead
        }
      }

      // Extract context window size from result messages
      if (msg.type === 'result') {
        const m = msg.message
        if (typeof m.modelUsage === 'object' && m.modelUsage !== null) {
          const modelUsage = m.modelUsage as Record<string, Record<string, unknown>>
          const first = Object.values(modelUsage)[0]
          if (first && typeof first.contextWindow === 'number') {
            s.contextWindow = first.contextWindow
          }
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

      // Scan backward through conversation to seed context state
      let foundTokens = false
      let foundWindow = false
      for (let i = s.conversation.length - 1; i >= 0; i--) {
        const row = s.conversation[i]
        if (!foundTokens && row.type === 'assistant' && !row.isSidechain) {
          const m = row.message
          if (typeof m.usage === 'object' && m.usage !== null) {
            const u = m.usage as Record<string, unknown>
            const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0
            const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0
            const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0
            s.contextTokens = input + cacheCreate + cacheRead
          }
          foundTokens = true
        }
        if (!foundWindow && row.type === 'result') {
          const m = row.message
          if (typeof m.modelUsage === 'object' && m.modelUsage !== null) {
            const modelUsage = m.modelUsage as Record<string, Record<string, unknown>>
            const first = Object.values(modelUsage)[0]
            if (first && typeof first.contextWindow === 'number') {
              s.contextWindow = first.contextWindow
            }
          }
          foundWindow = true
        }
        if (foundTokens && foundWindow) break
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
