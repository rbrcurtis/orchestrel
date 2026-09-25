import { describe, it, expect } from 'vitest';
import { resolveWorkDir, slugify } from './worktree';

describe('resolveWorkDir', () => {
  it('returns project path when branch is null', () => {
    expect(resolveWorkDir(null, '/home/user/project')).toBe('/home/user/project');
  });

  it('returns worktree path when branch is set', () => {
    expect(resolveWorkDir('my-feature', '/home/user/project')).toBe('/home/user/project/.worktrees/my-feature');
  });
});

describe('slugify', () => {
  it('converts title to branch-safe slug', () => {
    expect(slugify('Fix Login Bug')).toBe('fix-login-bug');
  });

  it('strips special chars and collapses dashes', () => {
    expect(slugify('hello!! world??')).toBe('hello-world');
  });

  it('truncates to 60 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBe(60);
  });
});
