import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { DataSource } from 'typeorm'
import { instanceToPlain } from 'class-transformer'
import { Project, ProjectSubscriber } from './Project'
import { messageBus } from '../bus'

let ds: DataSource

beforeAll(async () => {
  ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Project],
    subscribers: [ProjectSubscriber],
    synchronize: true,
  })
  await ds.initialize()
})

afterAll(async () => {
  await ds.destroy()
})

describe('Project entity', () => {
  it('publishes project:updated on insert and update', async () => {
    const proj = ds.getRepository(Project).create({
      name: 'Test project',
      path: '/tmp/test',
      createdAt: new Date().toISOString(),
    })
    await proj.save()

    const handler = vi.fn()
    messageBus.subscribe(`project:${proj.id}:updated`, handler)
    proj.name = 'Updated'
    await proj.save()
    expect(handler).toHaveBeenCalledOnce()
    messageBus.unsubscribe(`project:${proj.id}:updated`, handler)
  })

  it('publishes project:deleted on remove', async () => {
    const proj = ds.getRepository(Project).create({
      name: 'Delete me',
      path: '/tmp/delete',
      createdAt: new Date().toISOString(),
    })
    await proj.save()
    const id = proj.id
    const handler = vi.fn()
    messageBus.subscribe(`project:${id}:deleted`, handler)
    await proj.remove()
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id }))
    messageBus.unsubscribe(`project:${id}:deleted`, handler)
  })
})

describe('Project REST serialization', () => {
  it('only exposes rest-group fields via instanceToPlain', () => {
    const proj = Object.assign(new Project(), {
      id: 1,
      name: 'My Project',
      path: '/home/user/code/proj',
      setupCommands: 'pnpm install',
      isGitRepo: true,
      defaultBranch: 'main',
      defaultWorktree: true,
      defaultModel: 'sonnet',
      defaultThinkingLevel: 'high',
      providerID: 'anthropic',
      color: 'neon-cyan',
      createdAt: '2026-01-01T00:00:00Z',
    })

    const plain = instanceToPlain(proj, { groups: ['rest'], excludeExtraneousValues: true })

    expect(plain).toEqual({ id: 1, name: 'My Project' })
    expect(plain).not.toHaveProperty('path')
    expect(plain).not.toHaveProperty('setupCommands')
    expect(plain).not.toHaveProperty('defaultModel')
  })
})
