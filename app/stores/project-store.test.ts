import { autorun, configure } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from './project-store';
import type { Project } from '../../src/shared/ws-protocol';

afterEach(() => {
  configure({ enforceActions: 'never' });
  vi.restoreAllMocks();
});

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

  it('does not warn in strict mode when updateProject runs with observed data', async () => {
    configure({ enforceActions: 'always' });

    const store = new ProjectStore();
    store.hydrate([makeProject(1, 'Dispatcher')]);
    const dispose = autorun(() => store.active.map((p) => p.archived));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    store.setWs({ emit: vi.fn().mockResolvedValue(makeProject(1, 'Dispatcher', true)) } as never);
    await store.updateProject({ id: 1, archived: true });
    dispose();

    expect(errSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[MobX]'),
      expect.stringContaining('strict-mode is enabled'),
      expect.stringContaining('ProjectStore'),
    );
  });

  it('resolves project by trimmed lowercase name match', () => {
    const store = new ProjectStore();
    store.hydrate([makeProject(1, 'Alpha'), makeProject(2, 'beta'), makeProject(3, 'beta')]);

    expect(store.getProjectByName('  beta ')).toMatchObject({ id: 2, name: 'beta' });
    expect(store.getProjectByName('BETA')).toMatchObject({ id: 2, name: 'beta' });
  });

  it('resolves project refs by numeric id first, then by name', () => {
    const storeWithId = new ProjectStore();
    storeWithId.hydrate([makeProject(10, 'Ten'), makeProject(11, 'Ten')]);

    expect(storeWithId.resolveProjectRef('10')).toMatchObject({ id: 10, name: 'Ten' });
    expect(storeWithId.resolveProjectRef(' 10 ')).toMatchObject({ id: 10, name: 'Ten' });
    expect(storeWithId.resolveProjectRef('ten')).toMatchObject({ id: 10, name: 'Ten' });
    expect(storeWithId.resolveProjectRef('  tEn ')).toMatchObject({ id: 10, name: 'Ten' });

    const storeByNameOnly = new ProjectStore();
    storeByNameOnly.hydrate([makeProject(11, 'My Project')]);

    expect(storeByNameOnly.resolveProjectRef('My Project')).toMatchObject({ id: 11, name: 'My Project' });
    expect(storeByNameOnly.resolveProjectRef('  my project ')).toMatchObject({ id: 11, name: 'My Project' });
    expect(storeByNameOnly.resolveProjectRef('10')).toBeUndefined();
  });
});
