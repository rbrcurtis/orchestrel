import { makeAutoObservable, observable, runInAction } from 'mobx'
import type { AgentMessage, AgentStatus, FileRef } from '../../src/shared/ws-protocol'
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

export interface ConversationRow extends AgentMessage {
  id: string  // content hash for dedup
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
   * Timestamp is excluded from hash (varies between history/live).
   */
  ingest(cardId: number, msg: AgentMessage): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId)
      const { timestamp, ...stable } = msg
      const id = contentHashSync(msg.type, stable)

      if (s.conversationIds.has(id)) return // dedup

      s.conversation.push({ ...msg, id })
      s.conversationIds.add(id)

      // Extract context fill from text messages (skip sidechain)
      if (msg.type === 'text' && msg.usage && !msg.meta?.isSidechain) {
        const u = msg.usage
        const input = u.inputTokens ?? 0
        const cacheCreate = u.cacheWrite ?? 0
        const cacheRead = u.cacheRead ?? 0
        s.contextTokens = input + cacheCreate + cacheRead
      }

      // Extract context window size from turn_end messages
      if (msg.type === 'turn_end' && msg.usage?.contextWindow !== undefined) {
        s.contextWindow = msg.usage.contextWindow
      }
    })
  }

  /**
   * Ingest a batch of messages (history load from JSONL).
   * Prepends any messages not already in conversation (history comes first).
   * Only runs once per card (guards with historyLoaded flag).
   */
  ingestBatch(cardId: number, messages: AgentMessage[]): void {
    runInAction(() => {
      const s = this.getOrCreate(cardId)

      if (s.historyLoaded) return

      const newRows: ConversationRow[] = []

      for (const msg of messages) {
        const { timestamp, ...stable } = msg
        const id = contentHashSync(msg.type, stable)
        if (s.conversationIds.has(id)) continue

        newRows.push({ ...msg, id })
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
        if (!foundTokens && row.type === 'text' && row.usage && !row.meta?.isSidechain) {
          const u = row.usage
          const input = u.inputTokens ?? 0
          const cacheCreate = u.cacheWrite ?? 0
          const cacheRead = u.cacheRead ?? 0
          s.contextTokens = input + cacheCreate + cacheRead
          foundTokens = true
        }
        if (!foundWindow && row.type === 'turn_end' && row.usage?.contextWindow !== undefined) {
          s.contextWindow = row.usage.contextWindow
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

  handleAgentStatus(data: AgentStatus) {
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
        role: 'user',
        content: message,
        timestamp: Date.now(),
      })
    }

    const requestId = uuid()
    await ws().mutate({
      type: 'agent:send',
      requestId,
      data: { cardId, message, files },
    })
  }

  async stopSession(cardId: number): Promise<void> {
    const requestId = uuid()
    await ws().mutate({
      type: 'agent:stop',
      requestId,
      data: { cardId },
    })
  }

  async requestStatus(cardId: number): Promise<void> {
    const requestId = uuid()
    await ws().mutate({
      type: 'agent:status',
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
