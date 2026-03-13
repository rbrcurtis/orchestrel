import { EventEmitter } from 'events'

export type AgentType = 'claude' | 'kiro'

export type SessionStatus = 'starting' | 'running' | 'completed' | 'errored' | 'stopped'

export type AgentMessage = {
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'system' | 'turn_end' | 'error' | 'user' | 'tool_progress'
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCall?: {
    id: string
    name: string
    params?: Record<string, unknown>
  }
  toolResult?: {
    id: string
    output: string
    isError?: boolean
  }
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
    cacheWrite?: number
    contextWindow?: number
  }
  modelUsage?: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number
    contextWindow?: number
  }>
  meta?: Record<string, unknown>
  timestamp: number
}

export abstract class AgentSession extends EventEmitter {
  abstract sessionId: string | null
  abstract status: SessionStatus
  abstract promptsSent: number
  abstract turnsCompleted: number

  model?: string
  thinkingLevel?: string

  queryStartIndex = 0

  abstract start(prompt: string): Promise<void>
  abstract sendMessage(content: string): Promise<void>
  abstract kill(): Promise<void>
  abstract waitForReady(): Promise<void>
}
