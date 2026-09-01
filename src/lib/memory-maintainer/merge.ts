/* Weekly merge pass: group the week's staged store ops by memory server set
 * (apiUrl + project) and run one agent pass per group to merge near-duplicates
 * and recurring themes into durable memories. Never merges across server sets. */
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { OrchestrelConfig } from '../../shared/config';
import { buildModel, consolidate } from './consolidate';
import { finishRun, getDb, insertRun } from './db';
import { appendStaging, readStagingFile } from './staging';
import type { StagingEntry } from './staging';
import type { MemoryServer, StagedOp } from './memory-api';
import { buildMergePrompt } from './prompts';

export interface MergeSummary {
  groups: number;
  ops: number;
  stagingFile: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function collectWeekEntries(stageDir: string): StagingEntry[] {
  let names: string[];
  try {
    names = readdirSync(stageDir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const cutoff = Date.now() - WEEK_MS;
  const entries: StagingEntry[] = [];
  for (const name of names) {
    const path = join(stageDir, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) continue;
    const day = readStagingFile(path);
    if (day) entries.push(...day.entries);
  }
  return entries;
}

export function groupByServer(entries: StagingEntry[]): Array<{ key: string; entries: StagingEntry[] }> {
  const groups = new Map<string, StagingEntry[]>();
  for (const e of entries) {
    const key = `${e.project}@${e.apiUrl}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, entries: list }));
}

export async function runMerge(cfg: OrchestrelConfig): Promise<MergeSummary | null> {
  const memory = cfg.memory;
  if (!memory) return null;

  const db = getDb();
  const startedAt = new Date().toISOString();
  const runId = insertRun(db, 'weekly', startedAt);

  try {
    const entries = collectWeekEntries(memory.stageDir);
    if (entries.length === 0) {
      const summary: MergeSummary = { groups: 0, ops: 0, stagingFile: '' };
      finishRun(db, runId, 'done', JSON.stringify(summary));
      return summary;
    }
    const groups = groupByServer(entries);
    const { runtime, model } = await buildModel(cfg, memory);
    const mergedOps: StagedOp[] = [];

    for (const group of groups) {
      const [project] = group.key.split('@');
      // apiKey and project slug are not recoverable from staging files; look them up from config.
      const cfgEntry = memory.projects[project];
      if (!cfgEntry) continue;
      const first = group.entries[0];
      const server: MemoryServer = { apiUrl: first.apiUrl, apiKey: cfgEntry.apiKey, project: cfgEntry.project };
      const stores = group.entries.flatMap((e) => e.ops).filter((op): op is Extract<StagedOp, { op: 'store' }> => op.op === 'store');
      if (stores.length === 0) continue;
      const prompt = buildMergePrompt(
        stores.map((s) => ({ title: s.title, text: s.text })),
        group.entries.length,
      );
      const ops = await consolidate({
        excerpt: { sessionId: `merge-${group.key}`, cwd: '', startedAt: '', text: prompt, tokenEstimate: 0 },
        server,
        runtime,
        model,
        maxTurns: memory.maxTurns,
        mode: 'stage',
      });
      mergedOps.push(...ops);
    }

    const stagingFile = appendStaging(
      memory.stageDir,
      {
        project: 'merge',
        apiUrl: 'merge',
        sessionId: `merge-${new Date().toISOString().slice(0, 10)}`,
        source: 'merge',
        ops: mergedOps,
      },
      `merge-${new Date().toISOString().slice(0, 10)}.json`,
    );

    const summary: MergeSummary = { groups: groups.length, ops: mergedOps.length, stagingFile };
    finishRun(db, runId, 'done', JSON.stringify(summary));
    return summary;
  } catch (err) {
    finishRun(db, runId, 'failed', JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    throw err;
  }
}
