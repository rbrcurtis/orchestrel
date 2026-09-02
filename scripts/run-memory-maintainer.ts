/* Run the memory maintainer on demand and print a readable review summary:
 * per-project counts, the mutations (updates/deletes) staged today with their
 * reasons, and the staging file paths. Run any time with:
 *   bun run memory-maintainer:run            # daily consolidation
 *   bun run memory-maintainer:run --weekly   # weekly merge pass */
import arg from 'arg';
import { readFileSync } from 'fs';
import { loadConfig } from '../src/shared/config';
import { runMaintain } from '../src/lib/memory-maintainer/maintain';
import type { MaintainSummary } from '../src/lib/memory-maintainer/maintain';
import { runMerge } from '../src/lib/memory-maintainer/merge';
import type { StagingDay } from '../src/lib/memory-maintainer/staging';

function printMutations(stagingFiles: string[], sessionIds: string[]): void {
  const wanted = new Set(sessionIds);
  for (const file of stagingFiles) {
    let day: StagingDay;
    try {
      day = JSON.parse(readFileSync(file, 'utf8')) as StagingDay;
    } catch {
      continue;
    }
    const mutations = [
      ...new Map(
        day.entries
          .filter((e) => wanted.has(e.sessionId))
          .flatMap((e) =>
            e.ops
              .filter((op) => op.op === 'update' || op.op === 'delete')
              .map((op) => ({ ...op, source: e.source.split('/').pop() })),
          )
          .map((m) => [`${m.op}:${m.id}`, m]),
      ).values(),
    ];
    if (mutations.length === 0) continue;
    console.log(`\n${file} — ${mutations.length} mutation(s) from this run to review:`);
    for (const m of mutations) {
      if (m.op === 'update') {
        console.log(`  UPDATE ${m.id} (${m.source}) — ${m.title || '(title unchanged)'}`);
      } else {
        console.log(`  DELETE ${m.id} (${m.source}) — ${m.reason || 'no reason given'}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const args = arg({ '--weekly': Boolean });
  const cfg = loadConfig();

  if (args['--weekly']) {
    const summary = await runMerge(cfg);
    if (!summary) {
      console.log('maintainer disabled (no memory config)');
      return;
    }
    console.log(`weekly merge: ${summary.groups} group(s), ${summary.ops} ops → ${summary.stagingFile}`);
    return;
  }

  const started = Date.now();
  const summary: MaintainSummary | null = await runMaintain(cfg);
  if (!summary) {
    console.log('maintainer disabled (no memory config)');
    return;
  }
  if (summary.skipped) {
    console.log(`run #${summary.runId} skipped — another daily run already in progress`);
    return;
  }
  console.log(`run #${summary.runId} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const p of summary.projects) {
    console.log(
      `  ${p.project}: ${p.sessions} session(s) — ${p.stores} store, ${p.updates} update, ${p.deletes} delete, ${p.skips} skip${p.errors.length ? `, ${p.errors.length} error(s)` : ''}`,
    );
  }
  printMutations(summary.stagingFiles, summary.projects.flatMap((p) => p.sessionIds));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
