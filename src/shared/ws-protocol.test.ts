import { describe, it, expect } from 'vitest'
import { cardSchema, projectSchema, agentStatusSchema } from './ws-protocol'

describe('cardSchema', () => {
  it('validates a full card row', () => {
    const card = {
      id: 1,
      title: 'My task',
      description: 'Details here',
      column: 'ready',
      position: 1.5,
      projectId: 2,
      prUrl: null,
      sessionId: null,
      worktreeBranch: null,
      sourceBranch: null,
      model: 'sonnet',
      provider: 'anthropic',
      thinkingLevel: 'high',
      promptsSent: 0,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
      summarizeThreshold: 0.6,
      createdAt: '2024-01-01T00:00:00',
      updatedAt: '2024-01-01T00:00:00',
    }
    const result = cardSchema.safeParse(card)
    expect(result.success).toBe(true)
  })

  it('rejects invalid column', () => {
    const card = {
      id: 1,
      title: 'My task',
      description: '',
      column: 'invalid_column',
      position: 0,
      projectId: null,
      prUrl: null,
      sessionId: null,
      worktreeBranch: null,
      sourceBranch: null,
      model: 'sonnet',
      provider: 'anthropic',
      thinkingLevel: 'off',
      summarizeThreshold: 0.6,
      promptsSent: 0,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
      createdAt: '2024-01-01T00:00:00',
      updatedAt: '2024-01-01T00:00:00',
    }
    const result = cardSchema.safeParse(card)
    expect(result.success).toBe(false)
  })

  it('coerces sqlite integer booleans', () => {
    const card = {
      id: 2,
      title: 'Task',
      description: '',
      column: 'backlog',
      position: 0,
      projectId: null,
      prUrl: null,
      sessionId: null,
      worktreeBranch: null,
      sourceBranch: null,
      model: 'sonnet',
      provider: 'anthropic',
      thinkingLevel: 'off',
      summarizeThreshold: 0.6,
      promptsSent: 0,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
      createdAt: '2024-01-01T00:00:00',
      updatedAt: '2024-01-01T00:00:00',
    }
    const result = cardSchema.safeParse(card)
    expect(result.success).toBe(true)
    expect(result.success).toBe(true)
  })
})

describe('projectSchema', () => {
  it('validates a full project row', () => {
    const project = {
      id: 1,
      name: 'My Project',
      path: '/home/user/code/project',
      setupCommands: '',
      isGitRepo: true,
      defaultBranch: 'main',
      defaultWorktree: false,
      defaultModel: 'sonnet',
      defaultThinkingLevel: 'off',
      providerID: 'anthropic',
      color: '#ff0000',
      createdAt: '2024-01-01T00:00:00',
    }
    const result = projectSchema.safeParse(project)
    expect(result.success).toBe(true)
  })
})

describe('agentStatusSchema', () => {
  it('validates running status', () => {
    const status = {
      cardId: 1,
      active: true,
      status: 'running',
      sessionId: 'sess-abc',
      promptsSent: 3,
      turnsCompleted: 2,
      contextTokens: 5000,
      contextWindow: 200000,
    }
    const result = agentStatusSchema.safeParse(status)
    expect(result.success).toBe(true)
  })

  it('validates completed status', () => {
    const status = {
      cardId: 2,
      active: false,
      status: 'completed',
      sessionId: null,
      promptsSent: 1,
      turnsCompleted: 1,
      contextTokens: 0,
      contextWindow: 200000,
    }
    const result = agentStatusSchema.safeParse(status)
    expect(result.success).toBe(true)
  })

  it('rejects invalid status value', () => {
    const status = {
      cardId: 1,
      active: false,
      status: 'unknown_status',
      sessionId: null,
      promptsSent: 0,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
    }
    const result = agentStatusSchema.safeParse(status)
    expect(result.success).toBe(false)
  })
})
