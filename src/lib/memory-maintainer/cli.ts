/* Memory maintainer CLI: manual runs and status. Args parsed first, then main. */
import arg from 'arg';
import { loadConfig } from '../../shared/config';
import { getDb } from './db';
import { runMaintain } from './maintain';
import { runMerge } from './merge';

async function main(): Promise<void> {
  const args = arg({
    '--run': Boolean,
    '--weekly': Boolean,
    '--status': Boolean,
  });

  const cfg = loadConfig();

  if (args['--status']) {
    const db = getDb();
    const rows = db
      .prepare('SELECT id, run_type, status, started_at, finished_at FROM memory_maintainer_runs ORDER BY id DESC LIMIT 10')
      .all() as Array<Record<string, unknown>>;
    console.table(rows);
    return;
  }

  if (args['--weekly']) {
    const summary = await runMerge(cfg);
    console.log('merge:', summary ? `${summary.groups} groups, ${summary.ops} ops → ${summary.stagingFile}` : 'disabled (no memory config)');
    return;
  }

  if (args['--run']) {
    const summary = await runMaintain(cfg);
    if (!summary) {
      console.log('maintainer disabled (no memory config)');
      return;
    }
    console.log('done:', JSON.stringify(summary, null, 2));
    return;
  }

  console.log('usage: memory-maintainer --run | --weekly | --status');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
