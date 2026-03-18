import { resolve } from 'path'
import { Card } from '../models/Card'
import { Project } from '../models/Project'
import { sessionManager } from '../agents/manager'
import { OpenCodeSession } from '../agents/opencode/session'
import type { AgentMessage, SessionStatus } from '../agents/types'
import type { FileRef } from '../../shared/ws-protocol'
import {
  copyOpencodeConfig,
  createWorktree,
  runSetupCommands,
  slugify,
  worktreeExists,
} from '../worktree'
import { wireSession } from '../controllers/oc'

export interface SessionStatusData {
  cardId: number
  active: boolean
  status: SessionStatus
  sessionId: string | null
  promptsSent: number
  turnsCompleted: number
  contextTokens: number
  contextWindow: number
}

async function ensureWorktree(card: Card): Promise<string> {
  console.log(`[session:${card.id}] ensureWorktree: worktreePath=${card.worktreePath}, useWorktree=${card.useWorktree}, projectId=${card.projectId}`)
  if (card.worktreePath) return card.worktreePath

  if (!card.projectId) throw new Error(`Card ${card.id} has no project`)
  const proj = await Project.findOneByOrFail({ id: card.projectId })

  if (!card.useWorktree) {
    card.worktreePath = proj.path
    card.updatedAt = new Date().toISOString()
    await card.save()
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

  card.worktreePath = wtPath
  card.worktreeBranch = branch
  card.updatedAt = new Date().toISOString()
  await card.save()
  return wtPath
}

class SessionService {
  async sendFollowUp(cardId: number, message: string): Promise<void> {
    const session = sessionManager.get(cardId)
    if (!session) throw new Error(`No active session for card ${cardId}`)
    if (session.status !== 'running' && session.status !== 'completed') {
      throw new Error(`Session for card ${cardId} is ${session.status}, cannot send follow-up`)
    }

    if (session instanceof OpenCodeSession) {
      const card = await Card.findOneByOrFail({ id: cardId })
      session.updateModel(card.model, card.thinkingLevel)
    }

    await session.sendMessage(message)

    // Move back to running so the board reflects active work
    const card = await Card.findOneByOrFail({ id: cardId })
    card.promptsSent = session.promptsSent
    if (card.column !== 'running') card.column = 'running'
    card.updatedAt = new Date().toISOString()
    await card.save()
  }

  async startSession(cardId: number, message?: string, files?: FileRef[]): Promise<void> {
    const existing = sessionManager.get(cardId)
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      console.log(`[session:${cardId}] session already active, skipping startSession`)
      return
    }

    // New session
    const card = await Card.findOneByOrFail({ id: cardId })
    if (!card.title?.trim()) throw new Error('Title is required for running')
    if (!card.description?.trim()) throw new Error('Description is required for running')

    // Safety net: ensure card is in running. No-op when called via auto-start
    // (card is already running). Required when called from handleAgentSend for
    // cards in review — triggers board:changed so controller handlers subscribe.
    if (card.column !== 'running') {
      card.column = 'running'
      card.updatedAt = new Date().toISOString()
      await card.save()
    }

    // Handle file attachments
    let prompt = message ?? card.description
    if (!message) {
      prompt = card.description
    }
    if (files?.length) {
      for (const f of files) {
        if (!resolve(f.path).startsWith('/tmp/dispatcher-uploads/')) {
          throw new Error(`Invalid file path: ${f.path}`)
        }
      }
      const fileList = files
        .map(f => `- ${f.path} (${f.name}, ${f.mimeType})`)
        .join('\n')
      prompt = `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${prompt}`
    }

    console.log(`[session:${cardId}] startSession: calling ensureWorktree`)
    const cwd = await ensureWorktree(card)
    console.log(`[session:${cardId}] startSession: worktree ready at ${cwd}`)

    let providerID = 'anthropic'
    let projectName: string | undefined

    if (card.projectId) {
      const proj = await Project.findOneBy({ id: card.projectId })
      if (proj) {
        projectName = proj.name.toLowerCase()
        providerID = proj.providerID ?? 'anthropic'
      }
    }

    const isResume = !!card.sessionId
    console.log(`[session:${cardId}] startSession: creating session, provider=${providerID}, resume=${isResume}`)

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

    wireSession(cardId, session)

    console.log(`[session:${cardId}] startSession: calling session.start()`)
    await session.start(prompt)
    console.log(`[session:${cardId}] startSession: start() done, calling waitForReady()`)
    await session.waitForReady()
    console.log(`[session:${cardId}] startSession: session ready, sessionId=${session.sessionId}`)

    if (!isResume) {
      await card.reload()
      card.sessionId = session.sessionId
      card.promptsSent = 1
      card.turnsCompleted = 0
      card.updatedAt = new Date().toISOString()
      await card.save()
    }
  }

  async attachSession(cardId: number): Promise<boolean> {
    const card = await Card.findOneByOrFail({ id: cardId })
    if (!card.sessionId) return false

    const cwd = card.worktreePath
      ?? (card.projectId ? (await Project.findOneByOrFail({ id: card.projectId })).path : null)
    if (!cwd) return false

    // Check if session is alive in OC
    const port = Number(process.env.OPENCODE_PORT ?? 4097)
    try {
      const res = await fetch(`http://localhost:${port}/session/status`, {
        headers: { 'x-opencode-directory': cwd },
      })
      if (!res.ok) return false
      const statuses = await res.json() as Record<string, { type: string }>
      if (statuses[card.sessionId]?.type !== 'busy') return false
    } catch {
      return false
    }

    console.log(`[session:${cardId}] attachSession: session ${card.sessionId} is busy, attaching`)

    let providerID = 'anthropic'
    let projectName: string | undefined
    if (card.projectId) {
      const proj = await Project.findOneBy({ id: card.projectId })
      if (proj) {
        projectName = proj.name.toLowerCase()
        providerID = proj.providerID ?? 'anthropic'
      }
    }

    const session = sessionManager.create(cardId, {
      cwd,
      providerID,
      model: (card.model ?? 'sonnet') as 'sonnet' | 'opus' | 'auto',
      thinkingLevel: (card.thinkingLevel ?? 'high') as 'off' | 'low' | 'medium' | 'high',
      resumeSessionId: card.sessionId,
      projectName,
    })

    session.promptsSent = card.promptsSent ?? 0
    session.turnsCompleted = card.turnsCompleted ?? 0

    wireSession(cardId, session)
    await session.attach()

    return true
  }

  async sendMessage(cardId: number, message: string): Promise<void> {
    const existing = sessionManager.get(cardId)
    if (existing && (existing.status === 'running' || existing.status === 'completed')) {
      return this.sendFollowUp(cardId, message)
    }
    return this.startSession(cardId, message)
  }

  async stopSession(cardId: number): Promise<void> {
    await sessionManager.kill(cardId)
    // exit listener on the session handles card update to review

    // Fallback: abort via SDK even if no in-memory session (e.g., post-restart).
    // sessionManager.kill() is a no-op when the map is empty, but the OpenCode
    // session may still be running. Always send the SDK abort to be safe.
    const card = await Card.findOneBy({ id: cardId })
    if (card?.sessionId) {
      try {
        const { openCodeServer } = await import('../opencode/server')
        if (openCodeServer.client) {
          const sdk = openCodeServer.client as unknown as { session: { abort(opts: { sessionID: string }): Promise<void> } }
          await sdk.session.abort({ sessionID: card.sessionId })
          console.log(`[session:${cardId}] SDK abort sent for ${card.sessionId}`)
        }
      } catch {
        // Already idle or session gone — harmless
      }
    }
  }

  getStatus(cardId: number): SessionStatusData | null {
    const session = sessionManager.get(cardId)
    if (!session) return null
    return {
      cardId,
      active: session.status === 'running' || session.status === 'starting' || session.status === 'retry',
      status: session.status,
      sessionId: session.sessionId,
      promptsSent: session.promptsSent,
      turnsCompleted: session.turnsCompleted,
      contextTokens: 0,
      contextWindow: 200_000,
    }
  }

  async getHistory(sessionId: string, _cardId: number): Promise<AgentMessage[]> {
    const { openCodeServer } = await import('../opencode/server')
    if (!openCodeServer.client) return []

    interface SdkClient {
      session: {
        get(opts: { sessionID: string }): Promise<unknown>
        messages(opts: { sessionID: string }): Promise<unknown>
      }
    }
    const sdk = openCodeServer.client as unknown as SdkClient

    const session = await sdk.session.get({ sessionID: sessionId })
    if (!session || (session as { success?: boolean }).success === false) return []

    const rawMessages = await sdk.session.messages({ sessionID: sessionId })
    const rawMsgs = rawMessages as { success?: boolean; data?: unknown[] } | unknown[]
    const msgData = (rawMsgs as { success?: boolean }).success === false
      ? []
      : (rawMsgs as { data?: unknown[] }).data ?? (Array.isArray(rawMsgs) ? rawMsgs : [])
    const msgList = (Array.isArray(msgData) ? msgData : []) as Record<string, unknown>[]

    const normalized: AgentMessage[] = []
    for (const m of msgList) {
      normalized.push(...normalizeSessionMessage(m))
    }
    return normalized
  }
}

function normalizeSessionMessage(msg: Record<string, unknown>): AgentMessage[] {
  const results: AgentMessage[] = []
  const info = msg.info as { role?: string; time?: { created?: number } } | undefined
  const role = info?.role ?? (msg.role as string)
  const parts = (msg.parts ?? []) as Array<Record<string, unknown>>
  const infoTime = info?.time?.created
  const msgTime = typeof msg.time === 'object' && msg.time
    ? (msg.time as { created?: number }).created
    : undefined
  const ts = infoTime ?? msgTime ?? Date.now()

  for (const part of parts) {
    const partType = part.type as string

    if (partType === 'text') {
      results.push({
        type: role === 'user' ? 'user' : 'text',
        role: role === 'user' ? 'user' : 'assistant',
        content: (part.text as string) ?? '',
        timestamp: ts,
      })
    }

    if (partType === 'reasoning') {
      results.push({
        type: 'thinking',
        role: 'assistant',
        content: (part.text as string) ?? '',
        timestamp: ts,
      })
    }

    if (partType === 'tool') {
      const state = part.state as {
        status: string; input?: Record<string, unknown>
        output?: string; error?: string; title?: string
      } | undefined
      if (state) {
        results.push({
          type: 'tool_call',
          role: 'assistant',
          content: state.title ?? '',
          toolCall: {
            id: (part.callID as string) ?? (part.id as string),
            name: (part.tool as string) ?? 'unknown',
            params: state.input,
          },
          timestamp: ts,
        })
        if (state.status === 'completed') {
          results.push({
            type: 'tool_result',
            role: 'assistant',
            content: state.output ?? '',
            toolResult: {
              id: (part.callID as string) ?? (part.id as string),
              output: state.output ?? '',
              isError: false,
            },
            timestamp: ts,
          })
        }
        if (state.status === 'error') {
          results.push({
            type: 'tool_result',
            role: 'assistant',
            content: state.error ?? 'Tool error',
            toolResult: {
              id: (part.callID as string) ?? (part.id as string),
              output: state.error ?? 'Tool error',
              isError: true,
            },
            timestamp: ts,
          })
        }
      }
    }
  }
  return results
}

export const sessionService = new SessionService()
