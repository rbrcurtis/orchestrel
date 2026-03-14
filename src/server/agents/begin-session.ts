import type { WebSocket } from 'ws'
import { db } from '../db/index'
import { cards, projects } from '../db/schema'
import { eq } from 'drizzle-orm'
import { sessionManager } from './manager'
import type { AgentSession, AgentMessage, SessionStatus } from './types'
import type { ConnectionManager } from '../ws/connections'
import type { DbMutator } from '../db/mutator'
import {
  copyOpencodeConfig,
  createWorktree,
  runSetupCommands,
  slugify,
  worktreeExists,
} from '../worktree'
import { OpenCodeSession } from './opencode/session'

const DISPLAY_TYPES = new Set([
  'user', 'text', 'tool_call', 'tool_result', 'tool_progress', 'thinking', 'system', 'turn_end', 'error',
])

type HandlerPair = { message: (msg: AgentMessage) => void; exit: () => void }
const wsHandlers = new Map<number, Map<WebSocket, HandlerPair>>()

export function subscribeToSession(
  session: AgentSession,
  cardId: number,
  ws: WebSocket,
  connections: ConnectionManager,
  mutator: DbMutator,
): void {
  unsubscribeFromSession(cardId, ws)

  const messageHandler = (msg: AgentMessage) => {
    if (!DISPLAY_TYPES.has(msg.type)) return
    connections.send(ws, { type: 'agent:message', cardId, data: msg })
    if (msg.type === 'turn_end') {
      try {
        mutator.updateCard(cardId, {
          column: 'review',
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        })
      } catch (err) {
        console.error(`[session:${cardId}] failed to persist counters:`, err)
      }
      connections.send(ws, {
        type: 'agent:status',
        data: {
          cardId,
          active: true,
          status: 'completed' as SessionStatus,
          sessionId: session.sessionId,
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        },
      })
    }
  }

  const exitHandler = () => {
    console.log(`[session:${cardId}] exit, status=${session.status}`)
    // Only move to review on error or stop — session.idle keeps session alive
    if (session.status === 'errored' || session.status === 'stopped') {
      try {
        mutator.updateCard(cardId, {
          column: 'review',
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        })
      } catch (err) {
        console.error(`[session:${cardId}] failed to auto-move to review:`, err)
      }
    }
    connections.send(ws, {
      type: 'agent:status',
      data: {
        cardId,
        active: false,
        status: session.status as SessionStatus,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      },
    })
  }

  session.on('message', messageHandler)
  session.on('exit', exitHandler)

  if (!wsHandlers.has(cardId)) wsHandlers.set(cardId, new Map())
  wsHandlers.get(cardId)!.set(ws, { message: messageHandler, exit: exitHandler })
}

function unsubscribeFromSession(cardId: number, ws: WebSocket): void {
  const handlers = wsHandlers.get(cardId)?.get(ws)
  if (!handlers) return
  const session = sessionManager.get(cardId)
  if (session) {
    session.removeListener('message', handlers.message)
    session.removeListener('exit', handlers.exit)
  }
  wsHandlers.get(cardId)!.delete(ws)
  if (wsHandlers.get(cardId)!.size === 0) wsHandlers.delete(cardId)
}

export function unsubscribeAllSessions(ws: WebSocket): void {
  for (const [cardId] of wsHandlers) {
    if (!wsHandlers.get(cardId)?.has(ws)) continue
    unsubscribeFromSession(cardId, ws)
  }
}

function ensureWorktree(card: {
  id: number
  projectId: number | null
  useWorktree: boolean
  worktreePath: string | null
  worktreeBranch: string | null
  sourceBranch: string | null
  title: string
}, mutator: DbMutator): string {
  console.log(`[session:${card.id}] ensureWorktree: worktreePath=${card.worktreePath}, useWorktree=${card.useWorktree}, projectId=${card.projectId}`)
  if (card.worktreePath) return card.worktreePath

  if (!card.projectId) throw new Error(`Card ${card.id} has no project`)
  const proj = db.select().from(projects).where(eq(projects.id, card.projectId)).get()
  if (!proj) throw new Error(`Project ${card.projectId} not found`)

  if (!card.useWorktree) {
    mutator.updateCard(card.id, { worktreePath: proj.path })
    return proj.path
  }

  const slug = card.worktreeBranch || slugify(card.title)
  const wtPath = `${proj.path}/.worktrees/${slug}`
  const branch = slug
  const source = card.sourceBranch ?? proj.defaultBranch ?? undefined

  if (!worktreeExists(wtPath)) {
    console.log(`[session:${card.id}] worktree setup at ${wtPath}`)
    createWorktree(proj.path, wtPath, branch, source ?? undefined)
    if (proj.setupCommands) {
      console.log(`[session:${card.id}] running setup commands...`)
      runSetupCommands(wtPath, proj.setupCommands)
      console.log(`[session:${card.id}] setup commands done`)
    }
    copyOpencodeConfig(proj.path, wtPath)
  } else {
    console.log(`[session:${card.id}] worktree already exists at ${wtPath}`)
  }

  mutator.updateCard(card.id, { worktreePath: wtPath, worktreeBranch: branch })
  return wtPath
}

export async function beginSession(
  cardId: number,
  message: string | undefined,
  ws: WebSocket,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const card = db.select().from(cards).where(eq(cards.id, cardId)).get()
  if (!card) throw new Error(`Card ${cardId} not found`)
  if (!card.description) throw new Error(`Card ${cardId} has no description`)

  const existingSession = sessionManager.get(cardId)

  if (existingSession) {
    if (!message) throw new Error(`No message to send to existing session for card ${cardId}`)
    subscribeToSession(existingSession, cardId, ws, connections, mutator)

    if (existingSession instanceof OpenCodeSession) {
      existingSession.updateModel(card.model, card.thinkingLevel)
    }

    await existingSession.sendMessage(message)
    mutator.updateCard(cardId, { promptsSent: existingSession.promptsSent })

    connections.send(ws, {
      type: 'agent:status',
      data: {
        cardId,
        active: true,
        status: 'running',
        sessionId: card.sessionId,
        promptsSent: existingSession.promptsSent,
        turnsCompleted: existingSession.turnsCompleted,
      },
    })
  } else {
    const prompt = message ? card.description + '\n' + message : card.description
    console.log(`[session:${cardId}] beginSession: new session, calling ensureWorktree`)
    const cwd = ensureWorktree(card, mutator)
    console.log(`[session:${cardId}] beginSession: worktree ready at ${cwd}`)

    let providerID = 'anthropic'
    let projectName: string | undefined

    if (card.projectId) {
      const proj = db.select().from(projects).where(eq(projects.id, card.projectId)).get()
      if (proj) {
        projectName = proj.name.toLowerCase()
        providerID = proj.providerID ?? 'anthropic'
      }
    }

    console.log(`[session:${cardId}] beginSession: creating session, provider=${providerID}, resume=${!!card.sessionId}`)
    const isResume = !!card.sessionId
    const session = sessionManager.create(cardId, {
      cwd,
      providerID,
      model: (card.model ?? 'sonnet') as 'sonnet' | 'opus' | 'auto',
      thinkingLevel: (card.thinkingLevel ?? 'high') as 'off' | 'low' | 'medium' | 'high',
      resumeSessionId: card.sessionId ?? undefined,
      projectName,
    })

    if (isResume) {
      session.promptsSent = card.promptsSent ?? 0
      session.turnsCompleted = card.turnsCompleted ?? 0
    }

    subscribeToSession(session, cardId, ws, connections, mutator)

    console.log(`[session:${cardId}] beginSession: calling session.start()`)
    await session.start(prompt)
    console.log(`[session:${cardId}] beginSession: start() done, calling waitForReady()`)
    await session.waitForReady()
    console.log(`[session:${cardId}] beginSession: session ready, sessionId=${session.sessionId}`)

    if (!isResume) {
      mutator.updateCard(cardId, {
        sessionId: session.sessionId,
        promptsSent: 1,
        turnsCompleted: 0,
      })
    }

    connections.send(ws, {
      type: 'agent:status',
      data: {
        cardId,
        active: true,
        status: 'running',
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      },
    })
  }
}
