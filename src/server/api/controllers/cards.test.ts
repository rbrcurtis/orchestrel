import 'reflect-metadata'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
  const proj = await Project.save(Project.create({
    name: 'Test Project',
    path: '/tmp/test',
    providerID: 'anthropic',
    createdAt: new Date().toISOString(),
  }))
  projectId = proj.id
})

afterAll(async () => ds.destroy())
beforeEach(async () => ds.getRepository(Card).clear())

async function makeCard(column: string, title = column): Promise<Card> {
  const now = new Date().toISOString()
  return Card.save(Card.create({ title, description: `${title} description`, column, position: 0, projectId, createdAt: now, updatedAt: now }))
}

describe('CardsController card API', () => {
  it('lists every column and supports column and project filters', async () => {
    const { CardsController } = await import('./cards')
    await makeCard('ready', 'Ready')
    await makeCard('running', 'Running')

    const ctrl = new CardsController()
    const all = await ctrl.listCards(undefined, undefined, undefined, 50)
    const ready = await ctrl.listCards('ready', projectId, undefined, 50)

    expect(all.cards.map((card) => card.title).sort()).toEqual(['Ready', 'Running'])
    expect(all.total).toBe(2)
    expect(ready.cards).toHaveLength(1)
    expect(ready.cards[0]).toMatchObject({ title: 'Ready', column: 'ready', projectId })
  })

  it('searches card titles and descriptions case-insensitively', async () => {
    const { CardsController } = await import('./cards')
    await makeCard('ready', 'Deploy API')
    const descriptionMatch = await makeCard('review', 'Maintenance')
    descriptionMatch.description = 'Investigate ORCHESTREL latency'
    await descriptionMatch.save()
    await makeCard('backlog', 'Unrelated')

    const ctrl = new CardsController()
    const title = await ctrl.listCards(undefined, undefined, undefined, 50, '  deploy  ')
    const description = await ctrl.listCards(undefined, undefined, undefined, 50, 'orchestrel')

    expect(title.cards.map((card) => card.title)).toEqual(['Deploy API'])
    expect(title.total).toBe(1)
    expect(description.cards.map((card) => card.title)).toEqual(['Maintenance'])
    expect(description.total).toBe(1)
  })

  it('paginates cards without changing the filtered total', async () => {
    const { CardsController } = await import('./cards')
    const first = await makeCard('ready', 'First')
    await makeCard('ready', 'Second')
    await makeCard('ready', 'Third')

    const ctrl = new CardsController()
    const page = await ctrl.listCards('ready', undefined, undefined, 2)
    const next = await ctrl.listCards('ready', undefined, page.nextCursor, 2)

    expect(page.cards).toHaveLength(2)
    expect(page.total).toBe(3)
    expect(next.cards.map((card) => card.id)).toEqual([first.id])
    expect(next.total).toBe(3)
  })

  it('creates cards in running by default and returns operational fields', async () => {
    const { CardsController } = await import('./cards')
    const ctrl = new CardsController()
    const result = await ctrl.createCard({ title: 'Run now', description: 'Do the work', projectId })

    expect(result).toMatchObject({
      title: 'Run now',
      column: 'running',
      projectId,
      promptsSent: 0,
      execution: { active: false, status: 'unavailable' },
    })
    expect(result.version).toBe(1)
  })

  it('partially updates a card in any column, including its column', async () => {
    const { CardsController } = await import('./cards')
    const card = await makeCard('backlog', 'Original')
    const ctrl = new CardsController()

    const result = await ctrl.updateCard(card.id, { title: 'Updated', column: 'review' })

    expect(result).toMatchObject({ id: card.id, title: 'Updated', column: 'review' })
    expect(result.description).toBe('Original description')
  })

  it('rejects a stale If-Match value', async () => {
    const { CardsController } = await import('./cards')
    const card = await makeCard('ready')
    const ctrl = new CardsController()

    await expect(ctrl.updateCard(card.id, { title: 'Changed' }, `"card-${card.id}-v999"`))
      .rejects.toMatchObject({ status: 412, code: 'version_conflict' })
  })

  it('deletes cards outside ready', async () => {
    const { CardsController } = await import('./cards')
    const card = await makeCard('review')
    const ctrl = new CardsController()

    await ctrl.deleteCard(card.id)

    await expect(Card.findOneBy({ id: card.id })).resolves.toBeNull()
  })

  it('returns not found for a missing card', async () => {
    const { CardsController } = await import('./cards')
    const ctrl = new CardsController()

    await expect(ctrl.getCard(99999)).rejects.toMatchObject({ status: 404, code: 'card_not_found' })
  })
})
