import { makeAutoObservable } from 'mobx';
import type { Project, User } from '../../src/shared/ws-protocol';
import type { WsClient } from '../lib/ws-client';

export class ProjectStore {
  projects = new Map<number, Project>();
  users: User[] = [];
  private _ws: WsClient | null = null;

  constructor() {
    makeAutoObservable<this, '_ws'>(this, { _ws: false });
  }

  setWs(ws: WsClient) { this._ws = ws; }
  private ws(): WsClient {
    if (!this._ws) throw new Error('WsClient not set');
    return this._ws;
  }

  // ── Computed views ──────────────────────────────────────────────────────────

  getProject(id: number): Project | undefined {
    return this.projects.get(id);
  }

  get all(): Project[] {
    return Array.from(this.projects.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  get active(): Project[] {
    return this.all.filter((p) => !p.archived);
  }

  // ── Hydration ───────────────────────────────────────────────────────────────

  hydrate(items: unknown[], replace = false, users?: User[]) {
    if (replace) this.projects.clear();
    for (const p of items) {
      const project = p as Project;
      this.projects.set(project.id, project);
    }
    if (users) this.users = users;
  }

  handleUpdated(project: Project) {
    this.projects.set(project.id, project);
  }

  handleDeleted(id: number) {
    this.projects.delete(id);
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  serialize(): Project[] {
    return Array.from(this.projects.values());
  }

  // ── Optimistic mutations ────────────────────────────────────────────────────

  async createProject(data: {
    name: string;
    path: string;
    setupCommands?: string | null;
    defaultBranch?: 'main' | 'dev' | null;
    defaultWorktree?: boolean;
    defaultModel?: string;
    defaultThinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    color?: string | null;
    providerID?: string;
    memoryBaseUrl?: string | null;
    memoryApiKey?: string | null;
    archived?: boolean;
  }): Promise<Project> {
    const project = (await this.ws().emit('project:create', {
      ...data,
      setupCommands: data.setupCommands ?? undefined,
      color: data.color ?? undefined,
    })) as Project;
    this.projects.set(project.id, project);
    return project;
  }

  async updateProject(data: {
    id: number;
    name?: string;
    path?: string;
    setupCommands?: string | null;
    defaultBranch?: 'main' | 'dev' | null;
    defaultWorktree?: boolean;
    defaultModel?: string;
    defaultThinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    color?: string | null;
    providerID?: string;
    memoryBaseUrl?: string | null;
    memoryApiKey?: string | null;
    archived?: boolean;
    userIds?: number[];
  }): Promise<Project> {
    const existing = this.projects.get(data.id);
    if (existing) this.projects.set(data.id, { ...existing, ...data } as Project);

    try {
      const project = (await this.ws().emit('project:update', {
        ...data,
        setupCommands: data.setupCommands ?? undefined,
        color: data.color ?? undefined,
      })) as Project;
      this.projects.set(project.id, project);
      return project;
    } catch (err) {
      if (existing) this.projects.set(data.id, existing);
      throw err;
    }
  }

  async deleteProject(id: number): Promise<void> {
    const existing = this.projects.get(id);
    this.projects.delete(id);

    try {
      await this.ws().emit('project:delete', { id });
    } catch (err) {
      if (existing) this.projects.set(id, existing);
      throw err;
    }
  }

  async browse(path: string): Promise<unknown> {
    return this.ws().emit('project:browse', { path });
  }

  async mkdir(path: string): Promise<unknown> {
    return this.ws().emit('project:mkdir', { path });
  }
}
