import { existsSync } from 'fs'
import { readdir, mkdir } from 'fs/promises'
import { join } from 'path'
import { Project, NEON_COLORS } from '../models/Project'

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

class ProjectService {
  async listProjects(): Promise<Project[]> {
    return Project.find()
  }

  async createProject(data: Partial<Project>): Promise<Project> {
    // Auto-detect isGitRepo from path
    if (data.path) {
      data.isGitRepo = existsSync(join(data.path, '.git'))
    }

    // Auto-assign first unused neon color
    if (!data.color) {
      const used = (await Project.find({ select: { color: true } })).map(p => p.color)
      data.color = NEON_COLORS.find(c => !used.includes(c)) ?? NEON_COLORS[0]
    }

    const proj = Project.create({
      ...data,
      createdAt: new Date().toISOString(),
    })
    await proj.save()
    return proj
  }

  async updateProject(id: number, data: Partial<Project>): Promise<Project> {
    const proj = await Project.findOneByOrFail({ id })

    // Re-detect isGitRepo if path changes
    if (data.path) {
      data.isGitRepo = existsSync(join(data.path, '.git'))
    }

    Object.assign(proj, data)
    await proj.save()
    return proj
  }

  async deleteProject(id: number): Promise<void> {
    const proj = await Project.findOneByOrFail({ id })
    await proj.remove()
  }

  async browse(path: string): Promise<DirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: join(path, e.name), isDir: true }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }
}

export const projectService = new ProjectService()
