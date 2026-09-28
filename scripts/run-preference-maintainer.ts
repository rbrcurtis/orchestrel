/* Run the preference maintainer on demand and print a readable review summary:
 * per-user op counts and the location of the before/after trail files. Run:
 *   bun run preference-maintainer:run */
import { loadConfig } from '../src/shared/config';
import { runPreferences } from '../src/lib/preference-maintainer/maintain';
import type { PreferenceSummary } from '../src/lib/preference-maintainer/maintain';
import { TRAIL_DIR } from '../src/lib/preference-maintainer/trail';

async function main(): Promise<void> {
  const started = Date.now();
  const summary: PreferenceSummary | null = await runPreferences(loadConfig());
  if (!summary) {
    console.log('preference maintainer disabled (no memory.preferences config)');
    return;
  }
  if (summary.skipped) {
    console.log(`run #${summary.runId} skipped — another preference run already in progress`);
    return;
  }
  console.log(`run #${summary.runId} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const u of summary.users) {
    console.log(
      `  ${u.email} (user ${u.userId}): ${u.ops} op(s)${u.error ? ` — ERROR: ${u.error}` : ''}${u.trailFile ? ` → ${u.trailFile}` : ''}`,
    );
  }
  if (summary.users.length === 0) console.log('  no users with new human-authored prompts');
  console.log(`\nReview trail: ${TRAIL_DIR}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
