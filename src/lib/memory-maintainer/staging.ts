/* Per-day staging JSON. Append-only for the day; written atomically (tmp +
 * rename) so the review flow never reads a half-written file. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { StagedOp } from './memory-api';

export interface StagingEntry {
  project: string;
  apiUrl: string;
  sessionId: string;
  source: string;
  ops: StagedOp[];
}

export interface StagingDay {
  date: string;
  entries: StagingEntry[];
}

export function readStagingFile(path: string): StagingDay | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StagingDay;
  } catch {
    return null;
  }
}

export function appendStaging(stageDir: string, entry: StagingEntry, filename?: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const file = join(stageDir, filename ?? `${date}.json`);
  mkdirSync(stageDir, { recursive: true });
  const day = readStagingFile(file) ?? { date, entries: [] };
  day.entries.push(entry);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(day, null, 2));
  renameSync(tmp, file);
  return file;
}
