/* Preference maintainer CLI: manual runs and status. Args parsed first, then main. */
import arg from 'arg';
import { loadConfig } from '../../shared/config';
import { getDb } from '../memory-maintainer/db';
import { runPreferences } from './maintain';

async function main(): Promise<void> {
  const args = arg({
    '--run': Boolean,
    '--status': Boolean,
  });

  if (args['--status']) {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT id, run_type, status, started_at, finished_at FROM memory_maintainer_runs WHERE run_type = 'preference' ORDER BY id DESC LIMIT 10",
      )
      .all() as Array<Record<string, unknown>>;
    console.table(rows);
    return;
  }

  if (args['--run']) {
    const summary = await runPreferences(loadConfig());
    if (!summary) {
      console.log('preference maintainer disabled (no memory.preferences config)');
      return;
    }
    console.log('done:', JSON.stringify(summary, null, 2));
    return;
  }

  console.log('usage: preference-maintainer --run | --status');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
