import { resolve } from 'path'
import type { WebSocket } from 'ws'
import type { ClientMessage, ClaudeMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import { db } from '../../db/index'
import { cards, projects } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { sessionManager } from '../../claude/manager'
import type { ClaudeSession } from '../../claude/protocol'
import type { SessionStatus } from '../../claude/types'

// ── Shared helpers ────────────────────────────────────────────────────────────

function waitForInit(s: ClaudeSession): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for session init')), 30_000)
    const onMessage = () => {
      if (s.sessionId) {
        clearTimeout(timeout)
        s.off('message', onMessage)
        resolve()
      }
    }
    s.on('message', onMessage)
    s.on('exit', () => {
      clearTimeout(timeout)
      s.off('message', onMessage)
      reject(new Error('Session exited before init'))
    })
  })
}

function registerHandlers(
  session: ClaudeSession,
  cardId: number,
  ws: WebSocket,
  connections: ConnectionManager,
  mutator: DbMutator,
) {
  session.on('message', async (msg: Record<string, unknown>) => {
    // Only forward message types the client knows how to handle
    const knownTypes = new Set(['user', 'assistant', 'result', 'system'])
    if (!knownTypes.has(msg.type as string)) return

    // Forward every message to the WS client.
    // SDK assistant/user messages already have a nested `message` object ({role, content}).
    // Use that inner object as ClaudeMessage.message to match history format.
    // For flat messages (result, system), wrap the whole msg.
    const innerMsg = (msg.message && typeof msg.message === 'object')
      ? msg.message as Record<string, unknown>
      : msg
    const wrapped: ClaudeMessage = {
      type: msg.type as ClaudeMessage['type'],
      message: innerMsg,
      ...(msg.isSidechain !== undefined && { isSidechain: msg.isSidechain as boolean }),
      ...(msg.ts !== undefined && { ts: msg.ts as string }),
    }
    connections.send(ws, {
      type: 'claude:message',
      cardId,
      data: wrapped,
    })

    // On result messages, persist counters to DB
    if (msg.type === 'result') {
      try {
        mutator.updateCard(cardId, {
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        })
      } catch (err) {
        console.error(`Failed to persist counters for card ${cardId}:`, err)
      }
    }
  })

  session.on('exit', async () => {
    if (session.status !== 'completed' && session.status !== 'errored') return
    try {
      mutator.updateCard(cardId, {
        column: 'review',
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      })
    } catch (err) {
      console.error(`Failed to auto-move card ${cardId} to review:`, err)
    }
    connections.send(ws, {
      type: 'claude:status',
      data: {
        cardId,
        active: false,
        status: session.status as SessionStatus,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      },
    })
  })
}

// ── handleClaudeStart ─────────────────────────────────────────────────────────

export async function handleClaudeStart(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'claude:start' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId, prompt } } = msg

  try {
    const card = db.select().from(cards).where(eq(cards.id, cardId)).get()
    if (!card) throw new Error(`Card ${cardId} not found`)
    if (!card.worktreePath) throw new Error(`Card ${cardId} has no working directory`)

    let projectName: string | undefined
    if (card.projectId) {
      const proj = db.select({ name: projects.name }).from(projects).where(eq(projects.id, card.projectId)).get()
      if (proj) projectName = proj.name.toLowerCase()
    }

    const isResume = !!card.sessionId
    const session = sessionManager.create(
      cardId,
      card.worktreePath,
      card.sessionId ?? undefined,
      projectName,
      card.model,
      card.thinkingLevel,
    )

    // Register event handlers BEFORE starting
    registerHandlers(session, cardId, ws, connections, mutator)

    session.promptsSent++
    await session.start(prompt)
    await waitForInit(session)

    // For fresh sessions: store new sessionId, reset counters
    if (!isResume) {
      mutator.updateCard(cardId, {
        sessionId: session.sessionId,
        promptsSent: 1,
        turnsCompleted: 0,
      })
    }

    connections.send(ws, {
      type: 'claude:status',
      data: {
        cardId,
        active: true,
        status: 'running',
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      },
    })
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

// ── handleClaudeSend ──────────────────────────────────────────────────────────

export async function handleClaudeSend(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'claude:send' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId, message, files } } = msg

  try {
    // Always look up card so we have sessionId available for status messages
    const card = db.select().from(cards).where(eq(cards.id, cardId)).get()

    let session = sessionManager.get(cardId)

    // If no in-memory session, recreate from DB (e.g. after server restart)
    if (!session) {
      if (!card?.sessionId || !card.worktreePath) {
        throw new Error(`No session for card ${cardId}`)
      }
      let projectName: string | undefined
      if (card.projectId) {
        const proj = db.select({ name: projects.name }).from(projects).where(eq(projects.id, card.projectId)).get()
        if (proj) projectName = proj.name.toLowerCase()
      }
      session = sessionManager.create(cardId, card.worktreePath, card.sessionId, projectName, card.model, card.thinkingLevel)
      session.promptsSent = card.promptsSent ?? 0
      session.turnsCompleted = card.turnsCompleted ?? 0
      registerHandlers(session, cardId, ws, connections, mutator)
    } else if (session.status !== 'running') {
      // Session exists but is not running — re-register handlers so messages go to
      // the current WS connection (old handlers may point to a stale/closed socket)
      session.removeAllListeners('message')
      session.removeAllListeners('exit')
      registerHandlers(session, cardId, ws, connections, mutator)
    }

    // Refresh model/thinkingLevel from DB
    const freshCard = db.select({ model: cards.model, thinkingLevel: cards.thinkingLevel }).from(cards).where(eq(cards.id, cardId)).get()
    if (freshCard) {
      session.model = freshCard.model
      session.thinkingLevel = freshCard.thinkingLevel
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

    await session.sendUserMessage(prompt)

    mutator.updateCard(cardId, { promptsSent: session.promptsSent })

    // Notify client session is now running (triggers status transition completed→running so
    // the history reload effect fires when session completes)
    connections.send(ws, {
      type: 'claude:status',
      data: {
        cardId,
        active: true,
        status: 'running',
        sessionId: card?.sessionId ?? null,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      },
    })

    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

// ── handleClaudeStop ──────────────────────────────────────────────────────────

export async function handleClaudeStop(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'claude:stop' }>,
  connections: ConnectionManager,
  _mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId } } = msg

  try {
    await sessionManager.kill(cardId)
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

// ── handleClaudeStatus ────────────────────────────────────────────────────────

export async function handleClaudeStatus(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'claude:status' }>,
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

    connections.send(ws, { type: 'claude:status', data: statusData })
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}
