import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasEnabledScheduledJobs } from './scheduled-jobs';

const dirs: string[] = [];
function tempCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'orc-sched-'));
  dirs.push(d);
  return d;
}
function writeStore(cwd: string, name: string, jobs: Array<{ enabled?: boolean }>): void {
  const storeDir = join(cwd, '.pi', 'subagent-schedules');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, name), JSON.stringify({ version: 1, jobs }));
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('hasEnabledScheduledJobs', () => {
  it('returns false when the worktree has no schedule store', () => {
    expect(hasEnabledScheduledJobs(tempCwd())).toBe(false);
  });

  it('returns true when any store has an enabled job', () => {
    const cwd = tempCwd();
    writeStore(cwd, 'sess.json', [{ enabled: true }]);
    expect(hasEnabledScheduledJobs(cwd)).toBe(true);
  });

  it('returns false when all jobs are disabled (e.g. a fired once-job)', () => {
    const cwd = tempCwd();
    writeStore(cwd, 'sess.json', [{ enabled: false }, { enabled: false }]);
    expect(hasEnabledScheduledJobs(cwd)).toBe(false);
  });

  it('finds an enabled job in any session-scoped store file (id forks on resume)', () => {
    const cwd = tempCwd();
    writeStore(cwd, 'old-id.json', [{ enabled: false }]);
    writeStore(cwd, 'forked-id.json', [{ enabled: true }]);
    expect(hasEnabledScheduledJobs(cwd)).toBe(true);
  });

  it('ignores a corrupt/partial store file rather than throwing', () => {
    const cwd = tempCwd();
    const storeDir = join(cwd, '.pi', 'subagent-schedules');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, 'half-written.json'), '{"jobs": [{"enabl');
    expect(hasEnabledScheduledJobs(cwd)).toBe(false);
  });
});
