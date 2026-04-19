#!/usr/bin/env npx tsx
/**
 * CLI for repairing structural tool_use/tool_result corruption in a CC session
 * JSONL file (API Error: 400 due to tool use concurrency issues).
 *
 * Usage:
 *   npx tsx scripts/repair-session.ts --session <uuid>
 *   npx tsx scripts/repair-session.ts --session <uuid> --dry-run
 */
import arg from 'arg';
import { repairSession } from '../src/lib/session-repair.js';

const args = arg({
  '--session': String,
  '--dry-run': Boolean,
});

const sessionId = args['--session'];
const dryRun = args['--dry-run'] ?? false;

if (!sessionId) {
  console.error('Usage: npx tsx scripts/repair-session.ts --session <uuid> [--dry-run]');
  process.exit(1);
}

async function main(): Promise<void> {
  const result = await repairSession(sessionId!, { dryRun });

  if (!result.jsonlPath) {
    console.error(`No JSONL file found for session ${sessionId}`);
    process.exit(2);
  }

  console.log(`session:      ${result.sessionId}`);
  console.log(`jsonlPath:    ${result.jsonlPath}`);
  console.log(`entries:      ${result.linesBefore} → ${result.linesAfter}`);
  console.log(`groupsFixed:  ${result.groupsFixed}`);
  console.log(`groupsSkipped:${result.groupsSkipped}`);
  console.log(`msgIdsRekeyed:${result.msgIdsRekeyed}`);
  console.log(`dryRun:       ${result.dryRun}`);
  console.log(`changed:      ${result.changed}`);

  if (!result.changed) {
    console.log('\nNothing to repair.');
  } else if (result.dryRun) {
    console.log('\nDry run — no file written. Rerun without --dry-run to apply.');
  } else {
    console.log('\nRepair applied atomically.');
  }
}

main().catch(err => {
  console.error('Repair failed:', err);
  process.exit(1);
});
