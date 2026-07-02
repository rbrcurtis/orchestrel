import { readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { Project, DEFAULT_COLORS } from '../models/Project';
import { AppDataSource } from '../models/index';
import { defaultProviderFor } from '../config/capabilities';

// Project path validation runs on the project's node — orcd owns the node
// filesystem. The BE asks the node's client whether the path exists and is a
// git repo, rather than checking its own local filesystem.
async function validateOnNode(
  nodeName: string,
  path: string,
): Promise<{ isGitRepo: boolean; defaultBranch: string | null }> {
  const initState = await import('../init-state');
  const client = initState.getClientByNode(nodeName);
  if (!client || !client.isConnected()) {
    throw new Error(`node ${nodeName} is offline; cannot validate project path`);
  }
  const v = await client.pathValidate(path);
  if (!v.exists) throw new Error(`path does not exist on node ${nodeName}: ${path}`);
  return { isGitRepo: v.isGitRepo, defaultBranch: v.defaultBranch };
}

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
    const nodeName = data.nodeName ?? 'local';
    data.nodeName = nodeName;

    // Validate the path on the project's node
    if (data.path) {
      const v = await validateOnNode(nodeName, data.path);
      data.isGitRepo = v.isGitRepo;
      if (v.isGitRepo && !data.defaultBranch && v.defaultBranch) data.defaultBranch = v.defaultBranch;
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

    // Default providerID to the node's advertised default
    if (!data.providerID) {
      data.providerID = defaultProviderFor(nodeName) ?? 'anthropic';
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

    // Re-validate on the node if path changes
    if (data.path) {
      const v = await validateOnNode(data.nodeName ?? proj.nodeName, data.path);
      data.isGitRepo = v.isGitRepo;
      if (v.isGitRepo && data.defaultBranch == null && v.defaultBranch) data.defaultBranch = v.defaultBranch;
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
