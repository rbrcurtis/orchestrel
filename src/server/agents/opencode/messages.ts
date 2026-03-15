import type { AgentMessage } from '../types'

/**
 * Normalize OpenCode SSE events into Dispatcher AgentMessage format.
 *
 * Key event types from the SDK:
 * - message.part.updated — streaming parts (text, reasoning, tool, step-start/finish)
 * - message.updated — full message info (user/assistant)
 * - session.error — session-level error
 */
export function normalizeOpenCodeEvent(event: {
  type: string
  properties: Record<string, unknown>
}): AgentMessage | null {
  const ts = Date.now()

  switch (event.type) {
    case 'message.part.updated': {
      const { part, delta } = event.properties as {
        part: {
          type: string
          sessionID: string
          messageID: string
          text?: string
          tool?: string
          callID?: string
          state?: { status: string; input?: Record<string, unknown>; output?: string; error?: string; title?: string }
        }
        delta?: string
      }

      if (part.type === 'text') {
        // Use delta for streaming, fall back to full text
        return {
          type: 'text',
          role: 'assistant',
          content: delta ?? part.text ?? '',
          timestamp: ts,
        }
      }

      if (part.type === 'reasoning') {
        const content = delta ?? part.text ?? ''
        if (!content) return null // skip empty initial reasoning part
        return {
          type: 'thinking',
          role: 'assistant',
          content,
          timestamp: ts,
        }
      }

      if (part.type === 'tool' && part.state) {
        const st = part.state
        if (st.status === 'pending' || st.status === 'running') {
          return {
            type: 'tool_call',
            role: 'assistant',
            content: st.title ?? '',
            toolCall: {
              id: part.callID ?? part.messageID,
              name: part.tool ?? 'unknown',
              params: st.input,
            },
            timestamp: ts,
          }
        }
        if (st.status === 'completed') {
          return {
            type: 'tool_result',
            role: 'assistant',
            content: st.output ?? '',
            toolResult: {
              id: part.callID ?? part.messageID,
              output: st.output ?? '',
              isError: false,
            },
            timestamp: ts,
          }
        }
        if (st.status === 'error') {
          return {
            type: 'tool_result',
            role: 'assistant',
            content: st.error ?? 'Tool error',
            toolResult: {
              id: part.callID ?? part.messageID,
              output: st.error ?? 'Tool error',
              isError: true,
            },
            timestamp: ts,
          }
        }
      }

      return null
    }

    case 'message.updated': {
      const info = event.properties.info as {
        role?: string
        parts?: Array<{ type: string; text?: string }>
      } | undefined
      if (info?.role === 'user') {
        const textParts = info.parts?.filter((p) => p.type === 'text') ?? []
        const content = textParts.map((p) => p.text ?? '').join('\n')
        return {
          type: 'user',
          role: 'user',
          content,
          timestamp: ts,
        }
      }
      return null
    }

    case 'session.error': {
      const err = event.properties.error as { message?: string } | string | undefined
      const msg = typeof err === 'string' ? err : (err as { message?: string })?.message ?? 'Unknown error'
      return {
        type: 'error',
        role: 'system',
        content: msg,
        timestamp: ts,
      }
    }

    default:
      return null
  }
}
