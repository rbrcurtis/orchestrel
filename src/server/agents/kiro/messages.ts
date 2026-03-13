import type { AgentMessage } from '../types'

/**
 * Normalize a Kiro JSONL log entry to AgentMessage(s).
 *
 * JSONL format (v1):
 *   { version: "v1", kind: "Prompt" | "AssistantMessage" | "ToolResults", data: { message_id, content: [...] } }
 *
 * Each entry can produce multiple AgentMessages (one per content block).
 */
export function normalizeKiroLogEntry(entry: Record<string, unknown>): AgentMessage[] {
  const kind = entry.kind as string | undefined
  const data = entry.data as Record<string, unknown> | undefined
  if (!kind || !data) return []

  const ts = Date.now()
  const content = data.content as Array<Record<string, unknown>> | undefined
  if (!content) return []

  const messages: AgentMessage[] = []

  switch (kind) {
    case 'Prompt':
      for (const block of content) {
        if (block.kind === 'text') {
          messages.push({
            type: 'user',
            role: 'user',
            content: (block.data ?? '') as string,
            timestamp: ts,
          })
        }
      }
      break

    case 'AssistantMessage':
      for (const block of content) {
        if (block.kind === 'text') {
          const text = (block.data ?? '') as string
          if (text) {
            messages.push({
              type: 'text',
              role: 'assistant',
              content: text,
              timestamp: ts,
            })
          }
        } else if (block.kind === 'toolUse') {
          const td = block.data as Record<string, unknown>
          messages.push({
            type: 'tool_call',
            role: 'assistant',
            content: '',
            toolCall: {
              id: (td.toolUseId ?? '') as string,
              name: (td.name ?? '') as string,
              params: (td.input ?? {}) as Record<string, unknown>,
            },
            timestamp: ts,
          })
        }
      }
      // Add a turn_end after each assistant message
      messages.push({ type: 'turn_end', role: 'assistant', content: '', timestamp: ts })
      break

    case 'ToolResults':
      for (const block of content) {
        if (block.kind === 'toolResult') {
          const td = block.data as Record<string, unknown>
          const resultContent = td.content as Array<Record<string, unknown>> | undefined
          let output = ''
          if (resultContent) {
            output = resultContent
              .filter(c => c.kind === 'text')
              .map(c => (c.data ?? '') as string)
              .join('\n')
          }
          messages.push({
            type: 'tool_result',
            role: 'assistant',
            content: '',
            toolResult: {
              id: (td.toolUseId ?? '') as string,
              output: output.slice(0, 2000), // Truncate large outputs
              isError: (td.status ?? 'success') !== 'success',
            },
            timestamp: ts,
          })
        }
      }
      break
  }

  return messages
}

/**
 * Map ACP session/update notification params to a unified AgentMessage.
 *
 * ACP notifications arrive as:
 *   { sessionId, update: { sessionUpdate: "<event_type>", ...fields } }
 *
 * Known sessionUpdate values (discovered via kiro-cli 1.27.2):
 *   - agent_message_chunk: { content: { type: "text", text: "..." } }
 *   - tool_call:           { toolCallId, title, kind, status, rawInput? }
 *   - tool_call_update:    { toolCallId, title, kind, status, rawInput, rawOutput }
 *   - turn_end:            (signals end of agent turn — if present)
 */
export function normalizeKiroMessage(params: Record<string, unknown>): AgentMessage | null {
  // Handle both shapes: direct params (from JSONL) and nested update (from stdio)
  const update = (params.update ?? params) as Record<string, unknown>
  const eventType = (update.sessionUpdate ?? update.type) as string | undefined
  const ts = Date.now()

  switch (eventType) {
    case 'agent_message_chunk': {
      const content = update.content as Record<string, unknown> | undefined
      const text = (content?.text ?? '') as string
      if (!text) return null
      return {
        type: 'text',
        role: 'assistant',
        content: text,
        timestamp: ts,
      }
    }

    case 'tool_call': {
      const toolCallId = (update.toolCallId ?? '') as string
      const title = (update.title ?? '') as string
      const kind = (update.kind ?? '') as string
      const rawInput = update.rawInput as Record<string, unknown> | undefined
      // Skip the initial in_progress event (no rawInput yet) — only emit when we have details
      if (!rawInput) return null
      return {
        type: 'tool_call',
        role: 'assistant',
        content: title,
        toolCall: {
          id: toolCallId,
          name: kind || title,
          params: rawInput,
        },
        timestamp: ts,
      }
    }

    case 'tool_call_update': {
      const toolCallId = (update.toolCallId ?? '') as string
      const title = (update.title ?? '') as string
      const kind = (update.kind ?? '') as string
      const rawOutput = update.rawOutput as Record<string, unknown> | undefined
      const status = (update.status ?? '') as string
      // Extract output text from rawOutput
      let output = ''
      if (rawOutput) {
        const items = rawOutput.items as Array<Record<string, string>> | undefined
        if (items) {
          output = items.map(i => i.Text ?? i.text ?? '').join('\n')
        } else {
          output = JSON.stringify(rawOutput)
        }
      }
      // If status is completed, treat as tool_result
      if (status === 'completed') {
        return {
          type: 'tool_result',
          role: 'assistant',
          content: title,
          toolResult: {
            id: toolCallId,
            output,
            isError: false,
          },
          timestamp: ts,
        }
      }
      // Otherwise treat as progress
      return {
        type: 'tool_progress',
        role: 'assistant',
        content: output || title,
        toolCall: {
          id: toolCallId,
          name: kind || title,
        },
        timestamp: ts,
      }
    }

    case 'turn_end': {
      return {
        type: 'turn_end',
        role: 'assistant',
        content: '',
        timestamp: ts,
      }
    }

    // Replay events emitted during session/load — ignore silently
    case 'user_message_chunk':
      return null

    default:
      if (eventType) {
        console.debug(`[kiro] unrecognized event type: ${eventType}`)
      }
      return null
  }
}
