import type { AgentMessage } from '../types'

/**
 * Map ACP session/notification params to a unified AgentMessage.
 * Event type names and field structures are based on ACP protocol docs.
 * Log unrecognized events at debug level for discovery during integration.
 */
export function normalizeKiroMessage(params: Record<string, unknown>): AgentMessage | null {
  const eventType = params.type as string | undefined
  const ts = Date.now()

  switch (eventType) {
    case 'AgentMessageChunk': {
      const chunk = params.chunk as Record<string, unknown> | undefined
      const content = (chunk?.content ?? params.content ?? '') as string
      if (!content) return null
      return {
        type: 'text',
        role: 'assistant',
        content,
        timestamp: ts,
      }
    }

    case 'ToolCall': {
      const toolName = (params.toolName ?? params.tool_name ?? '') as string
      const toolCallId = (params.toolCallId ?? params.tool_call_id ?? '') as string
      const input = (params.input ?? params.params ?? {}) as Record<string, unknown>
      return {
        type: 'tool_call',
        role: 'assistant',
        content: '',
        toolCall: {
          id: toolCallId,
          name: toolName,
          params: input,
        },
        timestamp: ts,
      }
    }

    case 'ToolCallUpdate': {
      const toolCallId = (params.toolCallId ?? params.tool_call_id ?? '') as string
      const content = (params.content ?? params.output ?? '') as string
      return {
        type: 'tool_progress',
        role: 'assistant',
        content,
        toolCall: {
          id: toolCallId,
          name: '',
        },
        timestamp: ts,
      }
    }

    case 'ToolResult': {
      const toolCallId = (params.toolCallId ?? params.tool_call_id ?? '') as string
      const output = (params.output ?? params.content ?? '') as string
      const isError = (params.isError ?? params.is_error ?? false) as boolean
      return {
        type: 'tool_result',
        role: 'assistant',
        content: '',
        toolResult: {
          id: toolCallId,
          output,
          isError,
        },
        timestamp: ts,
      }
    }

    case 'TurnEnd': {
      return {
        type: 'turn_end',
        role: 'assistant',
        content: '',
        timestamp: ts,
      }
    }

    default:
      if (eventType) {
        console.debug(`[kiro] unrecognized event type: ${eventType}`)
      }
      return null
  }
}
