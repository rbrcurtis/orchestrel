import type { AgentMessage } from '../types'

export function normalizeOpenCodeEvent(event: {
  type: string
  properties: Record<string, unknown>
}): AgentMessage | null {
  const ts = Date.now()

  switch (event.type) {
    case 'message.part': {
      const part = event.properties as {
        type: string
        content?: string
        toolInvocation?: {
          toolCallId: string
          toolName: string
          args: Record<string, unknown>
          state: string
          result?: string
        }
      }

      if (part.type === 'text' || part.type === 'text-delta') {
        return {
          type: 'text',
          role: 'assistant',
          content: (part.content as string) ?? '',
          timestamp: ts,
        }
      }

      if (part.type === 'thinking' || part.type === 'reasoning') {
        return {
          type: 'thinking',
          role: 'assistant',
          content: (part.content as string) ?? '',
          timestamp: ts,
        }
      }

      if (part.type === 'tool-invocation' && part.toolInvocation) {
        const inv = part.toolInvocation
        if (inv.state === 'call' || inv.state === 'partial-call') {
          return {
            type: 'tool_call',
            role: 'assistant',
            content: '',
            toolCall: {
              id: inv.toolCallId,
              name: inv.toolName,
              params: inv.args,
            },
            timestamp: ts,
          }
        }
        if (inv.state === 'result') {
          return {
            type: 'tool_result',
            role: 'assistant',
            content: typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result),
            toolResult: {
              id: inv.toolCallId,
              output: typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result),
              isError: false,
            },
            timestamp: ts,
          }
        }
      }

      return null
    }

    case 'message.created': {
      const msg = event.properties as { role?: string; content?: string }
      if (msg.role === 'user') {
        return {
          type: 'user',
          role: 'user',
          content: (msg.content as string) ?? '',
          timestamp: ts,
        }
      }
      return null
    }

    case 'session.error': {
      return {
        type: 'error',
        role: 'system',
        content: (event.properties.message as string) ?? 'Unknown error',
        timestamp: ts,
      }
    }

    default:
      return null
  }
}
