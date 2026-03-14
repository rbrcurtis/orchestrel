import type { WebSocket } from 'ws'
import type { ClientMessage, AgentMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import { subscribeToSession } from '../../agents/begin-session'
import { sessionManager } from '../../agents/manager'
import { openCodeServer } from '../../opencode/server'

export async function handleSessionLoad(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'session:load' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { cardId, sessionId } = msg.data
  const { requestId } = msg

  if (!openCodeServer.client) {
    connections.send(ws, {
      type: 'mutation:error',
      requestId,
      error: 'OpenCode server not available',
    })
    return
  }

  interface SdkClient {
    session: {
      get(opts: { path: { id: string } }): Promise<unknown>
      messages(opts: { path: { id: string } }): Promise<unknown>
    }
  }
  const sdk = openCodeServer.client as unknown as SdkClient

  try {
    const session = await sdk.session.get({ path: { id: sessionId } })
    if (!session || (session as { success?: boolean }).success === false) {
      connections.send(ws, {
        type: 'session:history',
        requestId,
        cardId,
        messages: [],
      })
      connections.send(ws, { type: 'mutation:ok', requestId })
      return
    }

    const rawMessages = await sdk.session.messages({ path: { id: sessionId } })
    const rawMsgs = rawMessages as { success?: boolean; data?: unknown[] } | unknown[]
    const msgData = (rawMsgs as { success?: boolean }).success === false
      ? []
      : (rawMsgs as { data?: unknown[] }).data ?? (Array.isArray(rawMsgs) ? rawMsgs : [])
    const msgList: Record<string, unknown>[] = (Array.isArray(msgData) ? msgData : []) as Record<string, unknown>[]

    const normalized: AgentMessage[] = []
    for (const m of msgList) {
      normalized.push(...normalizeSessionMessage(m))
    }

    connections.send(ws, {
      type: 'session:history',
      requestId,
      cardId,
      messages: normalized,
    })
    connections.send(ws, { type: 'mutation:ok', requestId })

    const liveSession = sessionManager.get(cardId)
    if (liveSession) {
      subscribeToSession(liveSession, cardId, ws, connections, mutator)
    }
  } catch (err) {
    console.error(`[session:load] error loading session ${sessionId}:`, err)
    connections.send(ws, {
      type: 'mutation:error',
      requestId,
      error: `Failed to load session: ${err}`,
    })
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
      const state = part.state as { status: string; input?: Record<string, unknown>; output?: string; error?: string; title?: string } | undefined
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
