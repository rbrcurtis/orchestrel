import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { DataSource } from 'typeorm'
import { Card, CardSubscriber } from '../models/Card'
import { Project, ProjectSubscriber } from '../models/Project'
import { messageBus } from '../bus'

let ds: DataSource

beforeAll(async () => {
  ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Card, Project],
    subscribers: [CardSubscriber, ProjectSubscriber],
    synchronize: true,
  })
  await ds.initialize()
})

afterAll(async () => {
  await ds.destroy()
})

describe('SessionService.getStatus', () => {
  it('returns null when no session is active', async () => {
    const { sessionService } = await import('./session')
    expect(sessionService.getStatus(99999)).toBeNull()
  })
})

describe('SessionService.startSession validation', () => {
  it('throws when card not found', async () => {
    const { sessionService } = await import('./session')
    await expect(sessionService.startSession(99999)).rejects.toThrow()
  })

  it('throws when title is empty', async () => {
    const { sessionService } = await import('./session')
    const card = Card.create({
      title: '',
      description: 'Some description',
      column: 'ready',
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await card.save()
    await expect(sessionService.startSession(card.id)).rejects.toThrow('Title is required')
  })

  it('throws when description is empty', async () => {
    const { sessionService } = await import('./session')
    const card = Card.create({
      title: 'Some title',
      description: '',
      column: 'ready',
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await card.save()
    await expect(sessionService.startSession(card.id)).rejects.toThrow('Description is required')
  })
})
