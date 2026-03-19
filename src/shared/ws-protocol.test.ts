import { describe, it, expect } from 'vitest'
import { cardSchema, clientMessage, serverMessage } from './ws-protocol'

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
      worktreePath: null,
      worktreeBranch: null,
      useWorktree: true,
      sourceBranch: null,
      model: 'sonnet',
      thinkingLevel: 'high',
      promptsSent: 0,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
      createdAt: '2024-01-01T00:00:00',
      updatedAt: '2024-01-01T00:00:00',
      queuePosition: null,
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
      worktreePath: null,
      worktreeBranch: null,
      useWorktree: false,
      sourceBranch: null,
      model: 'sonnet',
      thinkingLevel: 'off',
      promptsSent: 0,
      turnsCompleted: 0,
      contextTokens: 0,
      contextWindow: 200000,
      createdAt: '2024-01-01T00:00:00',
      updatedAt: '2024-01-01T00:00:00',
      queuePosition: null,
    }
    const result = cardSchema.safeParse(card)
    expect(result.success).toBe(false)
  })
})

describe('clientMessage', () => {
  it('parses subscribe', () => {
    const msg = { type: 'subscribe', columns: ['backlog', 'ready'] }
    const result = clientMessage.safeParse(msg)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('subscribe')
  })

  it('parses page', () => {
    const msg = { type: 'page', column: 'backlog', limit: 20 }
    const result = clientMessage.safeParse(msg)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('page')
  })

  it('parses search', () => {
    const msg = { type: 'search', query: 'foo', requestId: 'r1' }
    const result = clientMessage.safeParse(msg)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('search')
  })

  it('rejects unknown type', () => {
    const msg = { type: 'unknown:action', data: {} }
    const result = clientMessage.safeParse(msg)
    expect(result.success).toBe(false)
  })
})

describe('serverMessage', () => {
  it('parses sync', () => {
    const msg = {
      type: 'sync',
      cards: [],
      projects: [],
      providers: {},
    }
    const result = serverMessage.safeParse(msg)
    expect(result.success).toBe(true)
  })

  it('parses mutation:ok without data', () => {
    const msg = { type: 'mutation:ok', requestId: 'req-1' }
    const result = serverMessage.safeParse(msg)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('mutation:ok')
  })

  it('parses mutation:ok with data', () => {
    const msg = { type: 'mutation:ok', requestId: 'req-1', data: { id: 42 } }
    const result = serverMessage.safeParse(msg)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('mutation:ok')
  })

  it('parses mutation:error', () => {
    const msg = { type: 'mutation:error', requestId: 'req-1', error: 'something went wrong' }
    const result = serverMessage.safeParse(msg)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('mutation:error')
  })

  it('parses card:updated', () => {
    const card = {
      id: 3,
      title: 'Updated',
      description: '',
      column: 'done',
      position: 0,
      projectId: null,
      prUrl: null,
      sessionId: null,
      worktreePath: null,
      worktreeBranch: null,
      useWorktree: false,
      sourceBranch: null,
      model: 'sonnet',
      thinkingLevel: 'off',
      promptsSent: 1,
      turnsCompleted: 1,
      contextTokens: 0,
      contextWindow: 200000,
      createdAt: '2024-01-01T00:00:00',
      updatedAt: '2024-01-02T00:00:00',
      queuePosition: null,
    }
    const msg = { type: 'card:updated', data: card }
    const result = serverMessage.safeParse(msg)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('card:updated')
  })

  it('parses page:result', () => {
    const msg = { type: 'page:result', column: 'backlog', cards: [], total: 0 }
    const result = serverMessage.safeParse(msg)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('page:result')
  })

  it('parses search:result', () => {
    const msg = { type: 'search:result', requestId: 'r1', cards: [], total: 0 }
    const result = serverMessage.safeParse(msg)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe('search:result')
  })
})
