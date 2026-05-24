import { existsSync } from 'fs';
import { readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { Project, DEFAULT_COLORS } from '../models/Project';
import { AppDataSource } from '../models/index';
import { getDefaultProviderID } from '../config/providers';

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

class ProjectService {
  async listProjects(): Promise<Project[]> {
    return Project.find();
  }

  async createProject(data: Partial<Project>): Promise<Project> {
    // Auto-detect isGitRepo from path
    if (data.path) {
      data.isGitRepo = existsSync(join(data.path, '.git'));
    }

    if (!data.isGitRepo) {
      data.defaultWorktree = false;
      data.defaultSandbox = false;
    } else if (!data.defaultWorktree) {
      data.defaultSandbox = false;
    }

    // Auto-assign first unused color from the default palette
    if (!data.color) {
      const used = (await Project.find({ select: { color: true } })).map((p) => p.color);
      data.color = DEFAULT_COLORS.find((c) => !used.includes(c)) ?? DEFAULT_COLORS[0];
    }

    // Default providerID to config-driven default
    if (!data.providerID) {
      data.providerID = getDefaultProviderID();
    }

    const proj = Project.create({
      ...data,
      createdAt: new Date().toISOString(),
    } as Partial<Project>) as Project;
    await proj.save();
    return proj;
  }

  async updateProject(id: number, data: Partial<Project>): Promise<Project> {
    const repo = AppDataSource.getRepository(Project);
    const proj = await repo.findOneByOrFail({ id });

    // Re-detect isGitRepo if path changes
    if (data.path) {
      data.isGitRepo = existsSync(join(data.path, '.git'));
    }

    const nextIsGitRepo = data.isGitRepo ?? proj.isGitRepo;
    const nextDefaultWorktree = data.defaultWorktree ?? proj.defaultWorktree;
    if (!nextIsGitRepo) {
      data.defaultWorktree = false;
      data.defaultSandbox = false;
    } else if (!nextDefaultWorktree) {
      data.defaultSandbox = false;
    }

    repo.merge(proj, data);
    await repo.save(proj);
    return proj;
  }

  async deleteProject(id: number): Promise<void> {
    const proj = await Project.findOneByOrFail({ id });
    await proj.remove();
  }

  async browse(path: string): Promise<DirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(path, e.name), isDir: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}

export const projectService = new ProjectService();
