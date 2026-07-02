import { describe, it, expect } from 'vitest';
import type { OrcdAction, OrcdMessage } from './orcd-protocol';

describe('orcd-protocol requestId', () => {
  it('allows an optional requestId on actions', () => {
    const a: OrcdAction = { action: 'list', requestId: 'r1' };
    expect(a.requestId).toBe('r1');
  });

  it('allows requestId to be omitted', () => {
    const a: OrcdAction = { action: 'list' };
    expect(a.requestId).toBeUndefined();
  });

  it('allows requestId echo on messages', () => {
    const m: OrcdMessage = { type: 'session_list', sessions: [], requestId: 'r1' };
    expect(m.requestId).toBe('r1');
  });

  it('models hello action and capabilities message', () => {
    const hello: OrcdAction = { action: 'hello', token: 'secret', requestId: 'h1' };
    expect(hello.action).toBe('hello');

    const caps: OrcdMessage = {
      type: 'capabilities',
      requestId: 'h1',
      name: 'gpubox',
      providers: [
        { id: 'anthropic', label: 'Anthropic', models: [{ alias: 'sonnet', label: 'Sonnet', contextWindow: 1000000 }] },
      ],
      defaults: { provider: 'anthropic', model: 'sonnet' },
    };
    expect(caps.type).toBe('capabilities');
  });

  it('models worktree and path actions with replies', () => {
    const prep: OrcdAction = {
      action: 'worktree_prepare', requestId: 'w1',
      projectPath: '/repo', branch: 'feat-x', sourceBranch: 'main', setupCommands: 'pnpm i',
    };
    expect(prep.action).toBe('worktree_prepare');

    const ready: OrcdMessage = { type: 'worktree_ready', requestId: 'w1', path: '/repo/.worktrees/feat-x', branch: 'feat-x' };
    expect(ready.type).toBe('worktree_ready');

    const rm: OrcdAction = { action: 'worktree_remove', requestId: 'w2', projectPath: '/repo', path: '/repo/.worktrees/feat-x' };
    expect(rm.action).toBe('worktree_remove');

    const ok: OrcdMessage = { type: 'ok', requestId: 'w2' };
    expect(ok.type).toBe('ok');

    const pv: OrcdAction = { action: 'path_validate', requestId: 'p1', path: '/repo' };
    expect(pv.action).toBe('path_validate');

    const pvr: OrcdMessage = { type: 'path_validated', requestId: 'p1', exists: true, isGitRepo: true, defaultBranch: 'main' };
    expect(pvr.type).toBe('path_validated');
  });
});
