import { describe, expect, it } from 'vitest';
import { ProjectStore } from './project-store';
import type { Project } from '../../src/shared/ws-protocol';

function makeProject(id: number, name: string, archived = false): Project {
  return {
    id,
    name,
    path: `/tmp/${name.toLowerCase().replace(/\s+/g, '-')}`,
    setupCommands: '',
    isGitRepo: true,
    defaultBranch: 'main',
    defaultWorktree: false,
    defaultModel: 'sonnet',
    defaultThinkingLevel: 'high',
    providerID: 'anthropic',
    color: '#00f0ff',
    memoryBaseUrl: null,
    memoryApiKey: null,
    createdAt: '2026-05-07T00:00:00.000Z',
    archived,
  } as Project;
}

describe('ProjectStore project views', () => {
  it('returns only non-archived projects from active', () => {
    const store = new ProjectStore();
    store.hydrate([makeProject(2, 'Beta'), makeProject(1, 'Alpha'), makeProject(3, 'Archive', true)]);

    expect(store.active.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
  });

  it('keeps archived projects in all', () => {
    const store = new ProjectStore();
    store.hydrate([makeProject(2, 'Beta'), makeProject(1, 'Alpha'), makeProject(3, 'Archive', true)]);

    expect(store.all.map((p) => p.name)).toEqual(['Alpha', 'Archive', 'Beta']);
  });
});
