import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DataSource } from 'typeorm'
import { Card, CardSubscriber } from '../../models/Card'
import { Project, ProjectSubscriber } from '../../models/Project'

let ds: DataSource
let proj1: Project
let proj2: Project

beforeAll(async () => {
  ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Card, Project],
    subscribers: [CardSubscriber, ProjectSubscriber],
    synchronize: true,
  })
  await ds.initialize()

  const now = new Date().toISOString()
  proj1 = Project.create({
    name: 'Alpha Project',
    path: '/tmp/alpha',
    providerID: 'anthropic',
    archived: false,
    createdAt: now,
  })
  await proj1.save()

  proj2 = Project.create({
    name: 'Beta Project',
    path: '/tmp/beta',
    providerID: 'anthropic',
    archived: true,
    createdAt: now,
  })
  await proj2.save()
})

afterAll(async () => {
  await ds.destroy()
})

describe('ProjectsController', () => {
  it('listProjects returns all projects', async () => {
    const { ProjectsController } = await import('./projects')
    const ctrl = new ProjectsController()
    const result = await ctrl.listProjects()
    expect(result.projects.length).toBeGreaterThanOrEqual(2)
  })

  it('listProjects returns only id and name — no path, setupCommands, etc.', async () => {
    const { ProjectsController } = await import('./projects')
    const ctrl = new ProjectsController()
    const result = await ctrl.listProjects()
    const p = result.projects.find(x => x.id === proj1.id)
    expect(p).toBeDefined()
    expect(p).toEqual({ id: proj1.id, name: 'Alpha Project', archived: false })
    expect(p).not.toHaveProperty('path')
    expect(p).not.toHaveProperty('setupCommands')
    expect(p).not.toHaveProperty('isGitRepo')
    expect(p).not.toHaveProperty('defaultModel')
  })

  it('listProjects includes archived state', async () => {
    const { ProjectsController } = await import('./projects')
    const ctrl = new ProjectsController()
    const result = await ctrl.listProjects()
    const archived = result.projects.find(x => x.id === proj2.id)
    expect(archived).toEqual({ id: proj2.id, name: 'Beta Project', archived: true })
  })

  it('listProjects includes all created projects', async () => {
    const { ProjectsController } = await import('./projects')
    const ctrl = new ProjectsController()
    const result = await ctrl.listProjects()
    const ids = result.projects.map(p => p.id)
    expect(ids).toContain(proj1.id)
    expect(ids).toContain(proj2.id)
  })
})
