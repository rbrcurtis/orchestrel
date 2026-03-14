import type { AgentSession } from './types'
import { OpenCodeSession } from './opencode/session'
import { resolveModel } from './opencode/models'
import { openCodeServer } from '../opencode/server'

export interface CreateSessionOpts {
  cwd: string
  providerID: string
  model: 'sonnet' | 'opus' | 'auto'
  thinkingLevel: 'off' | 'low' | 'medium' | 'high'
  resumeSessionId?: string
  projectName?: string
}

export function createAgentSession(opts: CreateSessionOpts): AgentSession {
  if (!openCodeServer.client) {
    throw new Error('OpenCode server not ready')
  }
  const { modelID, variant } = resolveModel(opts.providerID, opts.model, opts.thinkingLevel)
  return new OpenCodeSession(
    openCodeServer.client,
    opts.cwd,
    opts.providerID,
    modelID,
    variant,
    opts.resumeSessionId,
  )
}
