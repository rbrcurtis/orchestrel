import type { AgentMessage } from '../types'

type ContentBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  thinking?: string
}

export function normalizeClaudeMessage(msg: Record<string, unknown>): AgentMessage[] {
  const now = Date.now()
  const type = msg.type as string

  if (type === 'user') return [normalizeUserMessage(msg, now)]
  if (type === 'assistant') return normalizeAssistantMessage(msg, now)
  if (type === 'result') return [normalizeResultMessage(msg, now)]
  if (type === 'system') return [normalizeSystemMessage(msg, now)]

  if (type === 'tool_progress') {
    const inner = (msg.message ?? msg) as Record<string, unknown>
    return [{
      type: 'tool_progress' as const,
      role: 'assistant' as const,
      content: (inner.tool_name as string) ?? '',
      meta: { elapsedSeconds: inner.elapsed_time_seconds },
      timestamp: now,
    }]
  }

  return []
}

function normalizeUserMessage(msg: Record<string, unknown>, ts: number): AgentMessage {
  const inner = msg.message as { role?: string; content?: unknown } | undefined
  let content = ''
  if (typeof inner?.content === 'string') {
    content = inner.content
  } else if (Array.isArray(inner?.content)) {
    content = (inner!.content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n')
  }
  return { type: 'user', role: 'user', content, timestamp: ts }
}

function normalizeAssistantMessage(msg: Record<string, unknown>, ts: number): AgentMessage[] {
  const inner = msg.message as {
    content?: ContentBlock[]
    usage?: Record<string, number>
    model?: string
  } | undefined
  const content = inner?.content
  if (!content || !Array.isArray(content)) return []

  const isSidechain = msg.isSidechain as boolean | undefined
  const usage = inner?.usage
  const usageData = usage ? {
    inputTokens: (usage.input_tokens as number) ?? 0,
    outputTokens: (usage.output_tokens as number) ?? 0,
    cacheRead: (usage.cache_read_input_tokens as number) ?? 0,
    cacheWrite: (usage.cache_creation_input_tokens as number) ?? 0,
  } : undefined

  const results: AgentMessage[] = []

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      results.push({
        type: 'text',
        role: 'assistant',
        content: block.text,
        usage: usageData,
        meta: isSidechain ? { isSidechain: true } : undefined,
        timestamp: ts,
      })
    } else if (block.type === 'tool_use' && block.name && block.input) {
      results.push({
        type: 'tool_call',
        role: 'assistant',
        content: '',
        toolCall: {
          id: block.id ?? '',
          name: block.name,
          params: block.input,
        },
        timestamp: ts,
      })
    } else if (block.type === 'thinking' && block.thinking) {
      results.push({
        type: 'thinking',
        role: 'assistant',
        content: block.thinking,
        timestamp: ts,
      })
    }
  }

  // Attach usage only to the first text block (avoid double-counting)
  if (usageData && results.length > 1) {
    for (let i = 1; i < results.length; i++) {
      if (results[i].usage) results[i].usage = undefined
    }
  }

  return results
}

function normalizeResultMessage(msg: Record<string, unknown>, ts: number): AgentMessage {
  const inner = (msg.message ?? msg) as Record<string, unknown>
  const subtype = inner.subtype as string | undefined
  const rawTs = (msg.ts ?? inner.ts ?? inner._mtime) as string | undefined
  const timestamp = rawTs ? new Date(rawTs).getTime() : ts

  const modelUsage = inner.modelUsage as Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number
    contextWindow?: number
  }> | undefined

  let contextWindow: number | undefined
  if (modelUsage) {
    const first = Object.values(modelUsage)[0]
    if (first?.contextWindow) contextWindow = first.contextWindow
  }

  return {
    type: 'turn_end',
    role: 'system',
    content: subtype ?? 'success',
    usage: contextWindow ? { inputTokens: 0, outputTokens: 0, contextWindow } : undefined,
    modelUsage: modelUsage ?? undefined,
    meta: {
      subtype,
      durationMs: inner.duration_ms,
      totalCostUsd: inner.total_cost_usd,
      errors: inner.errors,
    },
    timestamp,
  }
}

function normalizeSystemMessage(msg: Record<string, unknown>, ts: number): AgentMessage {
  const inner = (msg.message ?? msg) as Record<string, unknown>
  const subtype = inner.subtype as string | undefined

  return {
    type: 'system',
    role: 'system',
    content: (inner.content as string) ?? '',
    meta: {
      subtype,
      model: inner.model,
      sessionId: inner.session_id ?? (msg as Record<string, unknown>).session_id,
      ...(subtype === 'compact_boundary' && { compactMetadata: inner.compact_metadata }),
    },
    timestamp: ts,
  }
}

export function normalizeToolResult(block: {
  type: string
  tool_use_id?: string
  content?: unknown
}, ts: number): AgentMessage | null {
  if (block.type !== 'tool_result' || !block.tool_use_id) return null

  let output = ''
  if (typeof block.content === 'string') {
    output = block.content
  } else if (Array.isArray(block.content)) {
    output = (block.content as Array<{ type: string; text?: string }>)
      .filter(b => b.text)
      .map(b => b.text!)
      .join('\n')
  }

  return {
    type: 'tool_result',
    role: 'user',
    content: '',
    toolResult: {
      id: block.tool_use_id,
      output,
    },
    timestamp: ts,
  }
}
