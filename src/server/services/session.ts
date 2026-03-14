import { resolve } from 'path'
import { Card } from '../models/Card'
import { Project } from '../models/Project'
import { messageBus } from '../bus'
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

const DISPLAY_TYPES = new Set([
  'user', 'text', 'tool_call', 'tool_result', 'tool_progress',
  'thinking', 'system', 'turn_end', 'error',
])

export interface SessionStatusData {
  cardId: number
  active: boolean
  status: SessionStatus
  sessionId: string | null
  promptsSent: number
  turnsCompleted: number
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
  async startSession(cardId: number, message?: string, files?: FileRef[]): Promise<void> {
    const existing = sessionManager.get(cardId)

    if (existing) {
      // Follow-up message to an existing session
      if (!message) throw new Error(`No message to send to existing session for card ${cardId}`)

      if (existing instanceof OpenCodeSession) {
        const card = await Card.findOneByOrFail({ id: cardId })
        existing.updateModel(card.model, card.thinkingLevel)
      }

      await existing.sendMessage(message)

      const card = await Card.findOneByOrFail({ id: cardId })
      card.promptsSent = existing.promptsSent
      if (card.column !== 'running') card.column = 'running'
      card.updatedAt = new Date().toISOString()
      await card.save()
      return
    }

    // New session
    const card = await Card.findOneByOrFail({ id: cardId })
    if (!card.title?.trim()) throw new Error('Title is required for running')
    if (!card.description?.trim()) throw new Error('Description is required for running')

    // Move to running only if not already there
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

    // Register one-time session-level listeners (server-owned, no WS reference)
    session.on('message', async (msg: AgentMessage) => {
      if (!DISPLAY_TYPES.has(msg.type)) return
      messageBus.publish(`card:${cardId}:message`, msg)

      if (msg.type === 'turn_end') {
        try {
          await card.reload()
          card.column = 'review'
          card.promptsSent = session.promptsSent
          card.turnsCompleted = session.turnsCompleted
          card.updatedAt = new Date().toISOString()
          await card.save()
          // Subscriber handles card:updated + card:status broadcasts
        } catch (err) {
          console.error(`[session:${cardId}] failed to persist turn_end:`, err)
        }
      }
    })

    session.on('exit', async () => {
      console.log(`[session:${cardId}] exit, status=${session.status}`)
      // Only move to review on error or stop — session.idle keeps session alive
      if (session.status === 'errored' || session.status === 'stopped') {
        try {
          await card.reload()
          card.column = 'review'
          card.promptsSent = session.promptsSent
          card.turnsCompleted = session.turnsCompleted
          card.updatedAt = new Date().toISOString()
          await card.save()
        } catch (err) {
          console.error(`[session:${cardId}] failed to auto-move to review on exit:`, err)
        }
      }
      // Publish exit status to bus so transport can forward agent:status
      messageBus.publish(`card:${cardId}:exit`, {
        cardId,
        active: false,
        status: session.status,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      })
    })

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

  async sendMessage(cardId: number, message: string): Promise<void> {
    return this.startSession(cardId, message)
  }

  async stopSession(cardId: number): Promise<void> {
    await sessionManager.kill(cardId)
    // exit listener on the session handles card update to review
  }

  getStatus(cardId: number): SessionStatusData | null {
    const session = sessionManager.get(cardId)
    if (!session) return null
    return {
      cardId,
      active: session.status === 'running',
      status: session.status,
      sessionId: session.sessionId,
      promptsSent: session.promptsSent,
      turnsCompleted: session.turnsCompleted,
    }
  }

  async getHistory(sessionId: string, _cardId: number): Promise<AgentMessage[]> {
    const { openCodeServer } = await import('../opencode/server')
    if (!openCodeServer.client) return []

    interface SdkClient {
      session: {
        get(opts: { path: { id: string } }): Promise<unknown>
        messages(opts: { path: { id: string } }): Promise<unknown>
      }
    }
    const sdk = openCodeServer.client as unknown as SdkClient

    const session = await sdk.session.get({ path: { id: sessionId } })
    if (!session || (session as { success?: boolean }).success === false) return []

    const rawMessages = await sdk.session.messages({ path: { id: sessionId } })
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
