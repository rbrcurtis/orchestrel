import { resolve } from 'path'
import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import { db } from '../../db/index'
import { cards } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { sessionManager } from '../../agents/manager'
import { beginSession } from '../../agents/begin-session'
import type { SessionStatus } from '../../agents/types'

// ── handleAgentSend ───────────────────────────────────────────────────────────

export async function handleAgentSend(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:send' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId, message, files } } = msg
  console.log(`[session:${cardId}] agent:send received, message length=${message.length}, files=${files?.length ?? 0}`)

  try {
    // Move card to running (validates title/description, sets up worktree)
    const existing = db.select().from(cards).where(eq(cards.id, cardId)).get()
    if (!existing) throw new Error(`Card ${cardId} not found`)

    if (existing.column !== 'running') {
      // Validate
      if (!existing.title?.trim()) throw new Error('Title is required for running')
      if (!existing.description?.trim()) throw new Error('Description is required for running')

      mutator.updateCard(cardId, { column: 'running' })
    }

    // Handle file refs: validate paths, build augmented prompt
    let prompt = message
    if (files?.length) {
      for (const f of files) {
        if (!resolve(f.path).startsWith('/tmp/dispatcher-uploads/')) {
          throw new Error(`Invalid file path: ${f.path}`)
        }
      }
      const fileList = files
        .map((f) => `- ${f.path} (${f.name}, ${f.mimeType})`)
        .join('\n')
      prompt = `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${prompt}`
    }

    // Respond immediately — beginSession runs in background
    connections.send(ws, { type: 'mutation:ok', requestId })

    beginSession(cardId, prompt, ws, connections, mutator).catch((err) => {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[session:${cardId}] beginSession error:`, error)
      connections.send(ws, {
        type: 'agent:status',
        data: {
          cardId,
          active: false,
          status: 'errored' as SessionStatus,
          sessionId: null,
          promptsSent: 0,
          turnsCompleted: 0,
        },
      })
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`[session:${cardId}] agent:send error:`, error)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

// ── handleAgentStop ───────────────────────────────────────────────────────────

export async function handleAgentStop(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:stop' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId } } = msg
  console.log(`[session:${cardId}] agent:stop received`)

  try {
    await sessionManager.kill(cardId)
    mutator.updateCard(cardId, { column: 'review' })
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`[session:${cardId}] agent:stop error:`, error)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

// ── handleAgentStatus ─────────────────────────────────────────────────────────

export async function handleAgentStatus(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:status' }>,
  connections: ConnectionManager,
  _mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId } } = msg

  try {
    const session = sessionManager.get(cardId)

    let statusData: {
      cardId: number
      active: boolean
      status: SessionStatus
      sessionId: string | null
      promptsSent: number
      turnsCompleted: number
    }

    if (session) {
      statusData = {
        cardId,
        active: session.status === 'running',
        status: session.status,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      }
    } else {
      // No active session — read counters from DB
      const card = db.select({
        promptsSent: cards.promptsSent,
        turnsCompleted: cards.turnsCompleted,
        sessionId: cards.sessionId,
      }).from(cards).where(eq(cards.id, cardId)).get()

      statusData = {
        cardId,
        active: false,
        status: 'completed',
        sessionId: card?.sessionId ?? null,
        promptsSent: card?.promptsSent ?? 0,
        turnsCompleted: card?.turnsCompleted ?? 0,
      }
    }

    connections.send(ws, { type: 'agent:status', data: statusData })
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}
