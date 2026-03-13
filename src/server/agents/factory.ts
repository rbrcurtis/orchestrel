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
        (opts.model ?? 'sonnet') as 'sonnet' | 'opus',
        (opts.thinkingLevel ?? 'high') as 'off' | 'low' | 'medium' | 'high',
      )
    case 'kiro':
      throw new Error('Kiro agent not yet implemented')
    default:
      throw new Error(`Unknown agent type: ${opts.agentType}`)
  }
}
