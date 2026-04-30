import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DataSource } from 'typeorm'
import { Card, CardSubscriber } from '../models/Card'
import { Project, ProjectSubscriber } from '../models/Project'

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

describe('CardService', () => {
  it('createCard sets position as max+1 in column', async () => {
    const { cardService } = await import('./card')
    const c1 = await cardService.createCard({ title: 'A', description: 'x', column: 'backlog' })
    const c2 = await cardService.createCard({ title: 'B', description: 'y', column: 'backlog' })
    expect(c2.position).toBeGreaterThan(c1.position)
  })

  it('searchCards returns matching cards', async () => {
    const { cardService } = await import('./card')
    await cardService.createCard({ title: 'Find me', description: 'unique-xyz', column: 'backlog' })
    const { cards, total } = await cardService.searchCards('unique-xyz')
    expect(total).toBeGreaterThanOrEqual(1)
    expect(cards.some(c => c.description === 'unique-xyz')).toBe(true)
  })

  it('pageCards returns sliced results with nextCursor', async () => {
    const { cardService } = await import('./card')
    // Create 3 cards in 'done' column for isolation
    await cardService.createCard({ title: 'P1', description: 'd', column: 'done' })
    await cardService.createCard({ title: 'P2', description: 'd', column: 'done' })
    await cardService.createCard({ title: 'P3', description: 'd', column: 'done' })
    const page = await cardService.pageCards('done', undefined, 2)
    expect(page.cards.length).toBe(2)
    expect(page.nextCursor).toBeDefined()
  })

  it('archiveOthers only archives active cards in the same project', async () => {
    const { cardService } = await import('./card')
    const { projectService } = await import('./project')
    const projectA = await projectService.createProject({ name: 'Archive project A', path: '/tmp/archive-project-a' })
    const projectB = await projectService.createProject({ name: 'Archive project B', path: '/tmp/archive-project-b' })
    const sameProject = await cardService.createCard({ title: 'Same project', description: 'd', column: 'ready', projectId: projectA.id })
    const otherProject = await cardService.createCard({ title: 'Other project', description: 'd', column: 'ready', projectId: projectB.id })
    const noProject = await cardService.createCard({ title: 'No project', description: 'd', column: 'ready' })
    const alreadyDone = await cardService.createCard({ title: 'Already done', description: 'd', column: 'done', projectId: projectA.id })

    const created = await cardService.createCard({
      title: 'New same project',
      description: 'd',
      column: 'backlog',
      projectId: projectA.id,
      archiveOthers: true,
    })

    expect((await Card.findOneByOrFail({ id: created.id })).column).toBe('backlog')
    expect((await Card.findOneByOrFail({ id: sameProject.id })).column).toBe('archive')
    expect((await Card.findOneByOrFail({ id: otherProject.id })).column).toBe('ready')
    expect((await Card.findOneByOrFail({ id: noProject.id })).column).toBe('ready')
    expect((await Card.findOneByOrFail({ id: alreadyDone.id })).column).toBe('done')
  })

  it('deleteCard removes the card', async () => {
    const { cardService } = await import('./card')
    const c = await cardService.createCard({ title: 'Delete', description: 'd', column: 'backlog' })
    await cardService.deleteCard(c.id)
    const found = await Card.findOneBy({ id: c.id })
    expect(found).toBeNull()
  })
})
