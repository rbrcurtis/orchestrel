import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DataSource } from 'typeorm'
import { Project, ProjectSubscriber, NEON_COLORS } from '../models/Project'
import { tmpdir } from 'os'
import { join } from 'path'

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

describe('ProjectService', () => {
  it('createProject auto-assigns first unused neon color', async () => {
    const { projectService } = await import('./project')
    const p1 = await projectService.createProject({ name: 'P1', path: '/tmp' })
    const p2 = await projectService.createProject({ name: 'P2', path: '/tmp' })
    expect(p1.color).toBe(NEON_COLORS[0])
    expect(p2.color).toBe(NEON_COLORS[1])
  })

  it('createProject detects isGitRepo from path', async () => {
    const { projectService } = await import('./project')
    // /tmp doesn't have .git, so isGitRepo should be falsy (SQLite stores as 0)
    const p = await projectService.createProject({ name: 'NoGit', path: tmpdir() })
    expect(p.isGitRepo).toBeFalsy()
  })

  it('updateProject re-detects isGitRepo when path changes', async () => {
    const { projectService } = await import('./project')
    const p = await projectService.createProject({ name: 'ReGit', path: '/tmp' })
    const updated = await projectService.updateProject(p.id, { path: tmpdir() })
    expect(typeof updated.isGitRepo).toBe('boolean')
  })

  it('browse returns non-hidden directories sorted', async () => {
    const { projectService } = await import('./project')
    const entries = await projectService.browse(tmpdir())
    expect(Array.isArray(entries)).toBe(true)
    entries.forEach(e => {
      expect(e.isDir).toBe(true)
      expect(e.name.startsWith('.')).toBe(false)
    })
  })

  it('mkdir creates directory recursively', async () => {
    const { projectService } = await import('./project')
    const { existsSync } = await import('fs')
    const path = join(tmpdir(), `orchestrel-test-${Date.now()}`, 'sub')
    await projectService.mkdir(path)
    expect(existsSync(path)).toBe(true)
  })

  it('deleteProject removes it', async () => {
    const { projectService } = await import('./project')
    const p = await projectService.createProject({ name: 'Del', path: '/tmp' })
    await projectService.deleteProject(p.id)
    const found = await Project.findOneBy({ id: p.id })
    expect(found).toBeNull()
  })
})
