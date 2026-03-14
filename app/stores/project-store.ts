import { makeAutoObservable } from 'mobx'
import type { Project } from '../../src/shared/ws-protocol'
import type { WsClient } from '../lib/ws-client'
import { uuid } from '../lib/utils'

let _ws: WsClient | null = null

export function setProjectStoreWs(ws: WsClient) {
  _ws = ws
}

function ws(): WsClient {
  if (!_ws) throw new Error('WsClient not set')
  return _ws
}

export class ProjectStore {
  projects = new Map<number, Project>()

  constructor() {
    makeAutoObservable(this)
  }

  // ── Computed views ──────────────────────────────────────────────────────────

  getProject(id: number): Project | undefined {
    return this.projects.get(id)
  }

  get all(): Project[] {
    return Array.from(this.projects.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  // ── Hydration ───────────────────────────────────────────────────────────────

  hydrate(items: unknown[], replace = false) {
    if (replace) this.projects.clear()
    for (const p of items) {
      const project = p as Project
      this.projects.set(project.id, project)
    }
  }

  handleUpdated(project: Project) {
    this.projects.set(project.id, project)
  }

  handleDeleted(id: number) {
    this.projects.delete(id)
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  serialize(): Project[] {
    return Array.from(this.projects.values())
  }

  // ── Optimistic mutations ────────────────────────────────────────────────────

  async createProject(data: {
    name: string
    path: string
    setupCommands?: string | null
    defaultBranch?: 'main' | 'dev' | null
    defaultWorktree?: boolean
    defaultModel?: 'sonnet' | 'opus' | 'auto'
    defaultThinkingLevel?: 'off' | 'low' | 'medium' | 'high'
    color?: string | null
    providerID?: string
  }): Promise<Project> {
    const requestId = uuid()
    const project = await ws().mutate<Project>({
      type: 'project:create',
      requestId,
      data,
    })
    this.projects.set(project.id, project)
    return project
  }

  async updateProject(data: {
    id: number
    name?: string
    path?: string
    setupCommands?: string | null
    defaultBranch?: 'main' | 'dev' | null
    defaultWorktree?: boolean
    defaultModel?: 'sonnet' | 'opus' | 'auto'
    defaultThinkingLevel?: 'off' | 'low' | 'medium' | 'high'
    color?: string | null
    providerID?: string
  }): Promise<Project> {
    const existing = this.projects.get(data.id)
    if (existing) this.projects.set(data.id, { ...existing, ...data } as Project)

    const requestId = uuid()
    try {
      const project = await ws().mutate<Project>({
        type: 'project:update',
        requestId,
        data,
      })
      this.projects.set(project.id, project)
      return project
    } catch (err) {
      if (existing) this.projects.set(data.id, existing)
      throw err
    }
  }

  async deleteProject(id: number): Promise<void> {
    const existing = this.projects.get(id)
    this.projects.delete(id)

    const requestId = uuid()
    try {
      await ws().mutate({ type: 'project:delete', requestId, data: { id } })
    } catch (err) {
      if (existing) this.projects.set(id, existing)
      throw err
    }
  }

  async browse(path: string): Promise<unknown> {
    const requestId = uuid()
    return ws().mutate({ type: 'project:browse', requestId, data: { path } })
  }

  async mkdir(path: string): Promise<unknown> {
    const requestId = uuid()
    return ws().mutate({ type: 'project:mkdir', requestId, data: { path } })
  }
}
