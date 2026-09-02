/* Daily maintainer run: sweep sessions, consolidate per configured project,
 * stage the proposed ops, alert via Telegram. Errors in one session or project
 * never abort the run; the watermark advances per file regardless so a
 * consistently-failing file is not retried forever. */
import type { OrchestrelConfig } from '../../shared/config';
import { buildModel, consolidate } from './consolidate';
import { buildExcerpt } from './excerpt';
import { finishRun, getDb, insertRun, recentActiveRun, upsertWatermark } from './db';
import { appendStaging } from './staging';
import { sendTelegramAlert } from './telegram';
import { sweepSessions } from './sweep';

export interface ProjectSummary {
  project: string;
  sessions: number;
  ops: number;
  stores: number;
  updates: number;
  deletes: number;
  skips: number;
  errors: string[];
  /** Session ids processed in this run — lets the run script filter staged mutations to this run's work. */
  sessionIds: string[];
}

export interface MaintainSummary {
  runId: number;
  projects: ProjectSummary[];
  stagingFiles: string[];
  durationMs: number;
  /** True when the run was skipped because another run of the same type is in progress. */
  skipped?: boolean;
}

export async function runMaintain(cfg: OrchestrelConfig): Promise<MaintainSummary | null> {
  const memory = cfg.memory;
  if (!memory) return null;

  const db = getDb();
  const startedAt = new Date().toISOString();
  const runId = insertRun(db, 'daily', startedAt);
  if (recentActiveRun(db, 'daily', runId)) {
    finishRun(db, runId, 'skipped', JSON.stringify({ reason: 'another daily run in progress' }));
    return { runId, projects: [], stagingFiles: [], durationMs: 0, skipped: true };
  }
  const started = Date.now();
  const stagingFiles = new Set<string>();
  const projects: ProjectSummary[] = [];

  try {
    const sweep = sweepSessions(memory);
    if (sweep.files.length === 0) {
      const summary: MaintainSummary = { runId, projects: [], stagingFiles: [], durationMs: Date.now() - started };
      finishRun(db, runId, 'done', JSON.stringify(summary));
      return summary;
    }
    const byProject = new Map<string, typeof sweep.files>();
    for (const f of sweep.files) {
      const list = byProject.get(f.projectKey) ?? [];
      list.push(f);
      byProject.set(f.projectKey, list);
    }

    const { runtime, model } = await buildModel(cfg, memory);
    for (const [key, files] of byProject) {
      const server = {
        apiUrl: memory.projects[key].apiUrl,
        apiKey: memory.projects[key].apiKey,
        project: memory.projects[key].project,
      };
      const summary: ProjectSummary = { project: key, sessions: 0, ops: 0, stores: 0, updates: 0, deletes: 0, skips: 0, errors: [], sessionIds: [] };
      for (const file of files) {
        try {
          const excerpt = buildExcerpt(file.path, memory.excerptTokens);
          const ops = await consolidate({ excerpt, server, runtime, model, maxTurns: memory.maxTurns, mode: memory.mode });
          const stagingFile = appendStaging(memory.stageDir, {
            project: key,
            apiUrl: server.apiUrl,
            sessionId: file.sessionId,
            source: file.path,
            ops,
          });
          stagingFiles.add(stagingFile);
          summary.sessions += 1;
          summary.sessionIds.push(file.sessionId);
          summary.ops += ops.length;
          for (const op of ops) {
            if (op.op === 'store') summary.stores += 1;
            else if (op.op === 'update') summary.updates += 1;
            else if (op.op === 'delete') summary.deletes += 1;
            else summary.skips += 1;
          }
        } catch (err) {
          summary.errors.push(`${file.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          upsertWatermark(db, file.path, file.mtimeMs, file.size);
        }
      }
      projects.push(summary);
    }

    const summary: MaintainSummary = { runId, projects, stagingFiles: [...stagingFiles], durationMs: Date.now() - started };
    finishRun(db, runId, 'done', JSON.stringify(summary));
    if (memory.telegram) {
      try {
        await sendTelegramAlert(memory.telegram.botToken, memory.telegram.chatId, buildAlertText(summary, memory.stageDir));
      } catch (err) {
        console.error('[memory-maintainer] telegram alert failed:', err);
      }
    }
    return summary;
  } catch (err) {
    finishRun(db, runId, 'failed', JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    throw err;
  }
}

export function buildAlertText(summary: MaintainSummary, _stageDir: string): string {
  if (summary.skipped) {
    return `Memory maintainer: run skipped — another daily run already in progress.`;
  }
  const lines = summary.projects.map(
    (p) =>
      `${p.project}: ${p.sessions} sessions, ${p.stores} stores, ${p.updates} updates, ${p.deletes} deletes, ${p.skips} skips${p.errors.length ? `, ${p.errors.length} errors` : ''}`,
  );
  return [
    `Memory maintainer (${new Date().toISOString().slice(0, 10)})`,
    ...lines,
    `Staged: ${summary.stagingFiles.join(', ') || 'none'}`,
    `Duration: ${summary.durationMs}ms`,
  ].join('\n');
}
