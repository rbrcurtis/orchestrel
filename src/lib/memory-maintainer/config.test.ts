import type { MemoryConfig } from '../../shared/config';
import { routeProject } from './config';

const MEMORY: MemoryConfig = {
  mode: 'stage',
  provider: 'max',
  model: 'assistant',
  maxTurns: 30,
  excerptTokens: 24000,
  stageDir: 'data/memory-staging',
  settleMs: 600000,
  projects: {
    trackable: {
      match: ['/home/ryan/Code/trackable', '/home/ryan/Code/transcription'],
      apiUrl: 'https://memory.trackable.io',
      apiKey: 'k',
      project: 'trackable',
    },
    other: {
      match: ['/home/ryan/Code/okkanti'],
      apiUrl: 'http://localhost:3100',
      apiKey: 'k',
      project: 'okkanti',
    },
  },
};

describe('routeProject', () => {
  it('routes a worktree cwd by longest prefix', () => {
    const hit = routeProject('/home/ryan/Code/trackable/.worktrees/trk-5587-fix', MEMORY);
    expect(hit?.key).toBe('trackable');
  });

  it('routes a top-level dir', () => {
    expect(routeProject('/home/ryan/Code/okkanti', MEMORY)?.key).toBe('other');
  });

  it('returns null for unconfigured cwds', () => {
    expect(routeProject('/home/ryan/Code/somewhere', MEMORY)).toBeNull();
  });
});
