#!/usr/bin/env npx tsx
/**
 * Test session summarization in isolation.
 *
 * Calls `summarizeSession(sessionId, model, opts)` and prints the result.
 * Does NOT modify the JSONL. Useful for reproducing summary-quality bugs
 * against past sessions without risking their content.
 *
 * Usage:
 *   npx tsx scripts/summarize.ts <session-id> <model>
 *   npx tsx scripts/summarize.ts <session-id> <model> [flags]
 *
 * Examples:
 *   npx tsx scripts/summarize.ts 5ea9184c-... claude-opus-4-7
 *   npx tsx scripts/summarize.ts <sid> claude-sonnet-4-7 --ratio 0.6
 *   npx tsx scripts/summarize.ts <sid> claude-haiku-4-7 --dry-run
 *
 * Flags:
 *   --ratio <n>         Fraction of oldest messages (default: 0.5)
 *   --max-excerpt <n>   Cap on excerpt chars (default: 120000)
 *   --jsonl <path>      Override JSONL path (else auto-locate by session id)
 *   --min-chars <n>     Minimum accepted summary length (default: 500)
 *   --dry-run           Build excerpt but skip the SDK call
 *   --out <path>        Write summary to file (default: stdout)
 */
import arg from 'arg';
import { writeFileSync } from 'fs';
import { summarizeSession } from '../src/lib/summarize-session';

const args = arg({
  '--ratio': Number,
  '--max-excerpt': Number,
  '--jsonl': String,
  '--min-chars': Number,
  '--dry-run': Boolean,
  '--out': String,
});

async function main(): Promise<void> {
  const [sessionId, model] = args._;
  if (!sessionId || !model) {
    console.error('Usage: npx tsx scripts/summarize.ts <session-id> <model> [flags]');
    process.exit(1);
  }

  const t0 = Date.now();
  const r = await summarizeSession(sessionId, model, {
    ratio: args['--ratio'],
    maxExcerptChars: args['--max-excerpt'],
    jsonlPath: args['--jsonl'],
    minSummaryChars: args['--min-chars'],
    dryRun: args['--dry-run'] ?? false,
  });
  const totalMs = Date.now() - t0;

  console.error(`Session:        ${r.sessionId}`);
  console.error(`Model:          ${model}`);
  console.error(`JSONL:          ${r.jsonlPath}`);
  console.error(`Messages:       ${r.messagesCovered}/${r.messagesBefore} (cutoff line ${r.lastOldLineIdx})`);
  console.error(`Excerpt:        ${r.excerptChars.toLocaleString()} chars`);
  if (!(args['--dry-run'] ?? false)) {
    console.error(`Summary:        ${r.summaryChars.toLocaleString()} chars (~${r.summaryTokens.toLocaleString()} tokens)`);
    console.error(`Compression:    ${(r.excerptChars / Math.max(r.summaryChars, 1)).toFixed(1)}x`);
    console.error(`SDK duration:   ${(r.durationMs / 1000).toFixed(1)}s`);
  }
  console.error(`Total wall:     ${(totalMs / 1000).toFixed(1)}s`);

  if (args['--dry-run']) return;

  if (args['--out']) {
    writeFileSync(args['--out'], r.summary);
    console.error(`\nSummary written to ${args['--out']}`);
  } else {
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(r.summary);
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
