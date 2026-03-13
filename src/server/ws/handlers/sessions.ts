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

  const sdk = openCodeServer.client as any

  try {
    const session = await sdk.session.get({ path: { id: sessionId } })
    if (!session) {
      connections.send(ws, {
        type: 'session:history',
        requestId,
        cardId,
        messages: [],
      })
      return
    }

    const rawMessages = await sdk.session.messages({ path: { id: sessionId } })
    const msgList = rawMessages.data ?? rawMessages ?? []

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
  const role = msg.role as string
  const parts = (msg.parts ?? []) as Array<Record<string, unknown>>
  const ts = msg.createdAt ? new Date(msg.createdAt as string).getTime() : Date.now()

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

    if (partType === 'thinking' || partType === 'reasoning') {
      results.push({
        type: 'thinking',
        role: 'assistant',
        content: (part.text as string) ?? (part.content as string) ?? '',
        timestamp: ts,
      })
    }

    if (partType === 'tool-invocation') {
      const inv = part.toolInvocation as Record<string, unknown> | undefined
      if (inv) {
        results.push({
          type: 'tool_call',
          role: 'assistant',
          content: '',
          toolCall: {
            id: inv.toolCallId as string,
            name: inv.toolName as string,
            params: inv.args as Record<string, unknown>,
          },
          timestamp: ts,
        })
        if (inv.state === 'result') {
          const output = typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result)
          results.push({
            type: 'tool_result',
            role: 'assistant',
            content: output,
            toolResult: {
              id: inv.toolCallId as string,
              output,
              isError: false,
            },
            timestamp: ts,
          })
        }
      }
    }
  }

  return results
}
