#!/usr/bin/env npx tsx
/**
 * Test Pi session summarization cutoff/excerpt selection in isolation.
 *
 * Calls `summarizeSession(sessionId, model, opts)` and prints the result.
 * Does NOT modify session state. Runtime compaction runs through orcd.
 *
 * Usage:
 *   npx tsx scripts/summarize.ts <session-id> <model> --dry-run [flags]
 *
 * Examples:
 *   npx tsx scripts/summarize.ts 5ea9184c-... pi-model --dry-run
 *   npx tsx scripts/summarize.ts <sid> pi-model --ratio 0.6 --dry-run
 *
 * Flags:
 *   --ratio <n>         Fraction of oldest messages (default: 0.5)
 *   --max-excerpt <n>   Cap on excerpt chars (default: 120000)
 *   --project <path>    Project path used to locate Pi session history
 *   --dry-run           Build excerpt; required because runtime compaction runs through orcd
 */
import arg from 'arg';
import { summarizeSession } from '../src/lib/summarize-session';

const args = arg({
  '--ratio': Number,
  '--max-excerpt': Number,
  '--project': String,
  '--dry-run': Boolean,
});

async function main(): Promise<void> {
  const [sessionId, model] = args._;
  if (!sessionId || !model) {
    console.error('Usage: npx tsx scripts/summarize.ts <session-id> <model> --dry-run [flags]');
    process.exit(1);
  }
  if (!(args['--dry-run'] ?? false)) {
    console.error('Fatal: --dry-run is required. Manual summary generation has been removed; compact active Pi sessions through orcd.');
    console.error('Usage: npx tsx scripts/summarize.ts <session-id> <model> --dry-run [flags]');
    process.exit(1);
  }

  const t0 = Date.now();
  const r = await summarizeSession(sessionId, model, {
    ratio: args['--ratio'],
    maxExcerptChars: args['--max-excerpt'],
    projectPath: args['--project'],
    dryRun: true,
  });
  const totalMs = Date.now() - t0;

  console.error(`Session:        ${r.sessionId}`);
  console.error(`Model:          ${model}`);
  console.error(`Source:         ${r.jsonlPath}`);
  console.error(`Messages:       ${r.messagesCovered}/${r.messagesBefore} (cutoff line ${r.lastOldLineIdx})`);
  console.error(`Excerpt:        ${r.excerptChars.toLocaleString()} chars`);
  console.error(`Total wall:     ${(totalMs / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
