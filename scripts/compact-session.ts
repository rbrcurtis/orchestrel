#!/usr/bin/env npx tsx
/**
 * CLI for compacting a Claude Code session's JSONL file.
 *
 * Usage:
 *   npx tsx scripts/compact-session.ts --session <uuid> --project-path <path>
 *   npx tsx scripts/compact-session.ts --session <uuid> --project-path <path> --dry-run
 *
 * Options:
 *   --session       Session UUID (required)
 *   --project-path  Absolute path to the project (required)
 *   --model         Model ID (default: deepseek/deepseek-chat-v3-0324)
 *   --ratio         Fraction of oldest messages to summarize (default: 0.5)
 *   --dry-run       Show what would be compacted without writing
 */
import arg from 'arg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { compactSession } from '../src/lib/session-compactor.js';

// ─── Args ────────────────────────────────────────────────────────────────────

const args = arg({
  '--session': String,
  '--project-path': String,
  '--model': String,
  '--ratio': Number,
  '--dry-run': Boolean,
});

const sessionId = args['--session'];
const projectPath = args['--project-path'];

if (!sessionId || !projectPath) {
  console.error('Usage: npx tsx scripts/compact-session.ts --session <uuid> --project-path <path> [--dry-run]');
  process.exit(1);
}

const model = args['--model'] ?? 'deepseek/deepseek-chat-v3-0324';
const ratio = args['--ratio'] ?? 0.5;
const dryRun = args['--dry-run'] ?? false;

// ─── Load OpenRouter config ─────────────────────────────────────────────────

interface ProviderBlock {
  baseUrl: string;
  apiKey: string;
}

function loadOpenRouterConfig(): ProviderBlock {
  const cfgPath = join(homedir(), '.orc', 'config.yaml');
  const raw = readFileSync(cfgPath, 'utf-8');

  const m = raw.match(/openrouter:\s*\n\s+baseUrl:\s*(.+)\n\s+apiKey:\s*(.+)/);
  if (!m) {
    console.error('Error: could not find openrouter provider in config');
    process.exit(1);
  }
  return {
    baseUrl: m[1].trim(),
    apiKey: m[2].trim(),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadOpenRouterConfig();

  console.error(`Compacting session ${sessionId}`);
  console.error(`  project-path: ${projectPath}`);
  console.error(`  model: ${model}`);
  console.error(`  ratio: ${ratio}`);
  console.error(`  dry-run: ${dryRun}`);

  const result = await compactSession({
    sessionId: sessionId!,
    projectPath: projectPath!,
    openRouterBaseUrl: cfg.baseUrl,
    openRouterApiKey: cfg.apiKey,
    model,
    ratio,
    dryRun,
  });

  console.error(`\nResult:`);
  console.error(`  JSONL path: ${result.jsonlPath}`);
  console.error(`  Messages after boundary: ${result.messagesBefore}`);
  console.error(`  Messages covered by summary: ${result.messagesCovered}`);
  console.error(`  Summary chars: ${result.summaryChars}`);
  console.error(`  Summary tokens (est): ${result.summaryTokens}`);
  console.error(`  Duration: ${result.durationMs}ms`);
  console.error(`  Usage: prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
