import { mkdtempSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryConfig } from '../../shared/config';
import { getDb, resetDb } from './db';
import { sweepSessions } from './sweep';

const MEMORY: MemoryConfig = {
  mode: 'stage', provider: 'max', model: 'assistant', maxTurns: 30,
  excerptTokens: 24000, stageDir: 'data/memory-staging', settleMs: 0, windowDays: 7,
  projects: {
    trackable: { match: ['/home/ryan/Code/trackable'], apiUrl: 'http://mem', apiKey: 'k', project: 'trackable' },
  },
};

let sessionsDir: string;
let oldDir: string | undefined;
beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'mm-sess-'));
  oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = sessionsDir;
  mkdirSync(join(sessionsDir, 'sessions', '--home-ryan-Code-trackable--'), { recursive: true });
});
afterEach(() => {
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldDir;
  resetDb();
});

function session(name: string, cwd: string, turns: number, mtimeMs: number): string {
  const p = join(sessionsDir, 'sessions', `--${cwd.replaceAll('/', '-').slice(1)}--`, name);
  mkdirSync(join(p, '..'), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', id: name, timestamp: '2026-08-31T00:00:00Z', cwd }),
    ...Array.from({ length: turns }, (_, i) => JSON.stringify({
      type: 'message', id: `m${i}`, timestamp: '2026-08-31T00:00:01Z',
      message: { role: i === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: 'x' }] },
    })),
  ];
  writeFileSync(p, lines.join('\n'));
  void mtimeMs;
  return p;
}

describe('sweepSessions', () => {
  it('classifies files by project and skips unconfigured cwds', () => {
    session('a.jsonl', '/home/ryan/Code/trackable', 4, 0);
    session('b.jsonl', '/home/ryan/Code/unconfigured', 4, 0);
    const result = sweepSessions(MEMORY);
    expect(result.files.map((f) => f.projectKey)).toEqual(['trackable']);
  });

  it('skips noisy sessions (no assistant turns) and already-seen files', () => {
    const p = session('c.jsonl', '/home/ryan/Code/trackable', 0, 0);
    const db = getDb();
    const st = statSync(p);
    db.prepare('INSERT INTO memory_maintainer_watermark (path, mtime_ms, size, processed_at) VALUES (?, ?, ?, ?)')
      .run(p, st.mtimeMs, st.size, '2026-08-31T00:00:00Z');
    expect(sweepSessions(MEMORY).files).toHaveLength(0);
  });

  it('skips sessions older than the recency window', () => {
    const p = session('old.jsonl', '/home/ryan/Code/trackable', 4, 0);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(p, old, old);
    const result = sweepSessions(MEMORY);
    expect(result.files).toHaveLength(0);
    expect(result.droppedWindow).toBe(1);
  });
});
