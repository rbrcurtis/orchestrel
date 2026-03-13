import type { AgentType, AgentSession } from './types'
import { ClaudeSession } from './claude/session'

export interface CreateSessionOpts {
  agentType: AgentType
  cwd: string
  resumeSessionId?: string
  projectName?: string
  model?: string
  thinkingLevel?: string
  agentProfile?: string
}

export function createAgentSession(opts: CreateSessionOpts): AgentSession {
  switch (opts.agentType) {
    case 'claude':
      return new ClaudeSession(
        opts.cwd,
        opts.resumeSessionId,
        opts.projectName,
        (opts.model as 'sonnet' | 'opus') ?? 'sonnet',
        (opts.thinkingLevel as 'off' | 'low' | 'medium' | 'high') ?? 'high',
      )
    case 'kiro':
      throw new Error('Kiro agent not yet implemented')
    default:
      throw new Error(`Unknown agent type: ${opts.agentType}`)
  }
}
