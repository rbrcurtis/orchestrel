import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { DataSource } from 'typeorm'
import { Card, CardSubscriber } from '../../models/Card'
import { Project, ProjectSubscriber } from '../../models/Project'

let ds: DataSource
let projectId: number

beforeAll(async () => {
  ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Card, Project],
    subscribers: [CardSubscriber, ProjectSubscriber],
    synchronize: true,
  })
  await ds.initialize()

  const proj = Project.create({
    name: 'Test Project',
    path: '/tmp/test',
    createdAt: new Date().toISOString(),
  })
  await proj.save()
  projectId = proj.id
})

afterAll(async () => {
  await ds.destroy()
})

beforeEach(async () => {
  await ds.getRepository(Card).clear()
})

describe('CardsController GET /api/cards', () => {
  it('returns only ready cards', async () => {
    const { CardsController } = await import('./cards')
    const now = new Date().toISOString()
    // Create cards in different columns
    await Card.save(Card.create({ title: 'Ready Card', description: 'ready desc', column: 'ready', position: 0, projectId, createdAt: now, updatedAt: now }))
    await Card.save(Card.create({ title: 'Backlog Card', description: 'backlog desc', column: 'backlog', position: 0, projectId, createdAt: now, updatedAt: now }))
    await Card.save(Card.create({ title: 'Running Card', description: 'running desc', column: 'running', position: 0, projectId, createdAt: now, updatedAt: now }))

    const ctrl = new CardsController()
    const result = await ctrl.listCards()
    expect(result.cards.length).toBe(1)
    expect(result.cards[0].title).toBe('Ready Card')
  })

  it('returns empty array when no ready cards exist', async () => {
    const { CardsController } = await import('./cards')
    const now = new Date().toISOString()
    await Card.save(Card.create({ title: 'Backlog Card', description: 'desc', column: 'backlog', position: 0, projectId, createdAt: now, updatedAt: now }))

    const ctrl = new CardsController()
    const result = await ctrl.listCards()
    expect(result.cards).toEqual([])
  })

  it('strips internal fields from response', async () => {
    const { CardsController } = await import('./cards')
    const now = new Date().toISOString()
    await Card.save(Card.create({ title: 'Test', description: 'desc', column: 'ready', position: 0, projectId, createdAt: now, updatedAt: now }))

    const ctrl = new CardsController()
    const result = await ctrl.listCards()
    const card = result.cards[0]
    expect(card).toHaveProperty('id')
    expect(card).toHaveProperty('title')
    expect(card).toHaveProperty('description')
    expect(card).toHaveProperty('projectId')
    expect(card).not.toHaveProperty('column')
    expect(card).not.toHaveProperty('position')
    expect(card).not.toHaveProperty('sessionId')
    expect(card).not.toHaveProperty('worktreePath')
    expect(card).not.toHaveProperty('model')
    expect(card).not.toHaveProperty('createdAt')
    expect(card).not.toHaveProperty('updatedAt')
  })
})

describe('CardsController POST /api/cards', () => {
  it('creates a card in ready column', async () => {
    const { CardsController } = await import('./cards')
    const ctrl = new CardsController()
    const result = await ctrl.createCard({ title: 'New Card', description: 'A description', projectId })
    expect(result.title).toBe('New Card')
    expect(result.description).toBe('A description')
    expect(result.projectId).toBe(projectId)

    // Verify it's actually in 'ready' column in DB
    const saved = await Card.findOneBy({ id: result.id })
    expect(saved?.column).toBe('ready')
  })

  it('rejects invalid projectId', async () => {
    const { CardsController } = await import('./cards')
    const ctrl = new CardsController()
    await expect(ctrl.createCard({ title: 'Card', description: 'desc', projectId: 99999 }))
      .rejects.toThrow('not found')
  })

  it('strips internal fields from POST response', async () => {
    const { CardsController } = await import('./cards')
    const ctrl = new CardsController()
    const result = await ctrl.createCard({ title: 'Strip Test', description: 'desc', projectId })
    expect(result).toHaveProperty('id')
    expect(result).toHaveProperty('title')
    expect(result).toHaveProperty('description')
    expect(result).toHaveProperty('projectId')
    expect(result).not.toHaveProperty('column')
    expect(result).not.toHaveProperty('position')
    expect(result).not.toHaveProperty('sessionId')
    expect(result).not.toHaveProperty('model')
  })
})

describe('CardsController PUT /api/cards/:id', () => {
  it('updates title and description of a ready card', async () => {
    const { CardsController } = await import('./cards')
    const now = new Date().toISOString()
    const card = await Card.save(Card.create({ title: 'Original', description: 'orig desc', column: 'ready', position: 0, projectId, createdAt: now, updatedAt: now }))

    const ctrl = new CardsController()
    const result = await ctrl.updateCard(card.id, { title: 'Updated Title', description: 'Updated desc' })
    expect(result.title).toBe('Updated Title')
    expect(result.description).toBe('Updated desc')
    expect(result.id).toBe(card.id)
  })

  it('returns 404 for non-ready card', async () => {
    const { CardsController } = await import('./cards')
    const now = new Date().toISOString()
    const card = await Card.save(Card.create({ title: 'Backlog', description: 'desc', column: 'backlog', position: 0, projectId, createdAt: now, updatedAt: now }))

    const ctrl = new CardsController()
    await expect(ctrl.updateCard(card.id, { title: 'New', description: 'New desc' }))
      .rejects.toThrow('not found or not in ready column')
  })

  it('returns 404 for nonexistent card', async () => {
    const { CardsController } = await import('./cards')
    const ctrl = new CardsController()
    await expect(ctrl.updateCard(99999, { title: 'New', description: 'New desc' }))
      .rejects.toThrow('not found or not in ready column')
  })

  it('strips internal fields from PUT response', async () => {
    const { CardsController } = await import('./cards')
    const now = new Date().toISOString()
    const card = await Card.save(Card.create({ title: 'Strip', description: 'desc', column: 'ready', position: 0, projectId, createdAt: now, updatedAt: now }))

    const ctrl = new CardsController()
    const result = await ctrl.updateCard(card.id, { title: 'Strip Updated', description: 'Updated' })
    expect(result).toHaveProperty('id')
    expect(result).toHaveProperty('title')
    expect(result).toHaveProperty('description')
    expect(result).toHaveProperty('projectId')
    expect(result).not.toHaveProperty('column')
    expect(result).not.toHaveProperty('position')
    expect(result).not.toHaveProperty('sessionId')
    expect(result).not.toHaveProperty('model')
  })
})

describe('CardsController DELETE /api/cards/:id', () => {
  it('deletes a ready card', async () => {
    const { CardsController } = await import('./cards')
    const now = new Date().toISOString()
    const card = await Card.save(Card.create({ title: 'Delete Me', description: 'desc', column: 'ready', position: 0, projectId, createdAt: now, updatedAt: now }))

    const ctrl = new CardsController()
    await ctrl.deleteCard(card.id)

    const found = await Card.findOneBy({ id: card.id })
    expect(found).toBeNull()
  })

  it('returns 404 for non-ready card', async () => {
    const { CardsController } = await import('./cards')
    const now = new Date().toISOString()
    const card = await Card.save(Card.create({ title: 'Running', description: 'desc', column: 'running', position: 0, projectId, createdAt: now, updatedAt: now }))

    const ctrl = new CardsController()
    await expect(ctrl.deleteCard(card.id))
      .rejects.toThrow('not found or not in ready column')
  })

  it('returns 404 for nonexistent card', async () => {
    const { CardsController } = await import('./cards')
    const ctrl = new CardsController()
    await expect(ctrl.deleteCard(99999))
      .rejects.toThrow('not found or not in ready column')
  })
})
