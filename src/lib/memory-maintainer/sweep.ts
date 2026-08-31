/* Session sweep: find new, settled session files under the pi agent sessions
 * dir, classify each by cwd → configured memory project. Watermark skips files
 * already seen with identical mtime+size. */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { MemoryConfig } from '../../shared/config';
import { routeProject } from './config';
import { getDb } from './db';

export interface SessionFile {
  path: string;
  mtimeMs: number;
  size: number;
  sessionId: string;
  cwd: string;
  projectKey: string;
}

export interface SweepResult {
  files: SessionFile[];
  droppedUnsettled: number;
  droppedUnknownProject: number;
  droppedNoise: number;
}

interface SessionHeader {
  id?: string;
  cwd?: string;
}

export function sweepSessions(memory: MemoryConfig): SweepResult {
  const sessionsDir = join(getAgentDir(), 'sessions');
  const db = getDb();
  const now = Date.now();
  const files: SessionFile[] = [];
  const result: SweepResult = { files, droppedUnsettled: 0, droppedUnknownProject: 0, droppedNoise: 0 };

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return result; // sessions dir does not exist yet — nothing to do
  }

  for (const dirName of projectDirs) {
    const dirPath = join(sessionsDir, dirName);
    let names: string[];
    try {
      names = readdirSync(dirPath).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dirPath, name);
      const st = statSync(path);
      if (st.mtimeMs > now - memory.settleMs) {
        result.droppedUnsettled += 1;
        continue;
      }
      const seen = db
        .prepare('SELECT mtime_ms, size FROM memory_maintainer_watermark WHERE path = ?')
        .get(path) as { mtime_ms: number; size: number } | undefined;
      if (seen && seen.mtime_ms === st.mtimeMs && seen.size === st.size) continue;

      const header = readHeader(path);
      if (!header?.cwd) continue;
      const routed = routeProject(header.cwd, memory);
      if (!routed) {
        result.droppedUnknownProject += 1;
        continue;
      }
      const stats = scanSession(path);
      if (stats.userMessages === 0 || stats.assistantTurns < 3) {
        result.droppedNoise += 1;
        continue;
      }
      files.push({
        path,
        mtimeMs: st.mtimeMs,
        size: st.size,
        sessionId: header.id ?? name,
        cwd: header.cwd,
        projectKey: routed.key,
      });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return result;
}

function readHeader(path: string): SessionHeader | undefined {
  try {
    const first = readFileSync(path, 'utf8').split('\n', 1)[0];
    const entry = JSON.parse(first) as { type?: string; id?: string; cwd?: string };
    if (entry.type !== 'session') return undefined;
    return { id: entry.id, cwd: entry.cwd };
  } catch {
    return undefined;
  }
}

function scanSession(path: string): { userMessages: number; assistantTurns: number } {
  let userMessages = 0;
  let assistantTurns = 0;
  const fd = readFileSync(path, 'utf8');
  for (const line of fd.split('\n')) {
    if (!line) continue;
    let entry: { type?: string; message?: { role?: string } };
    try {
      entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
    } catch {
      continue;
    }
    if (entry.type !== 'message') continue;
    if (entry.message?.role === 'user') userMessages += 1;
    if (entry.message?.role === 'assistant') assistantTurns += 1;
  }
  return { userMessages, assistantTurns };
}
