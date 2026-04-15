#!/usr/bin/env npx tsx
/**
 * Test conversation summarization against OpenRouter (Gemma 4 31B-IT).
 *
 * Usage:
 *   npx tsx scripts/test-summarize.ts --session <session-id> --project-slug <slug>
 *   npx tsx scripts/test-summarize.ts --jsonl <path-to-jsonl>
 *
 * Options:
 *   --session       Session UUID (looks up JSONL under ~/.claude/projects/<slug>/)
 *   --project-slug  CC project slug (default: auto-detect from --jsonl path)
 *   --jsonl         Direct path to JSONL file
 *   --ratio         Fraction of oldest messages to summarize (default: 0.5)
 *   --model         OpenRouter model ID (default: google/gemma-4-31b-it)
 *   --max-excerpt   Max chars for the excerpt sent to summarizer (default: 120000)
 *   --provider      OpenRouter provider preference (e.g. "Parasail")
 *   --dry-run       Just show the excerpt, don't call the API
 */
import arg from 'arg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CHARS_PER_TOKEN = 3.5;

// ─── Args ────────────────────────────────────────────────────────────────────

const args = arg({
  '--session': String,
  '--project-slug': String,
  '--jsonl': String,
  '--ratio': Number,
  '--model': String,
  '--max-excerpt': Number,
  '--provider': String,
  '--dry-run': Boolean,
  '--config': String,
});

const ratio = args['--ratio'] ?? 0.5;
const modelId = args['--model'] ?? 'google/gemma-4-31b-it';
const maxExcerpt = args['--max-excerpt'] ?? 120_000;
const provider = args['--provider'] ?? undefined;
const dryRun = args['--dry-run'] ?? false;

// ─── Resolve JSONL path ──────────────────────────────────────────────────────

function resolveJsonlPath(): string {
  if (args['--jsonl']) return args['--jsonl'];
  const sessionId = args['--session'];
  const slug = args['--project-slug'];
  if (!sessionId) {
    console.error('Error: provide --jsonl or --session');
    process.exit(1);
  }
  if (!slug) {
    console.error('Error: provide --project-slug when using --session');
    process.exit(1);
  }
  return join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

// ─── Load config for OpenRouter API key ──────────────────────────────────────

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  models: string[];
}

function loadOpenRouterConfig(): ProviderConfig {
  const cfgPath = args['--config'] ?? join(homedir(), '.orc', 'config.yaml');
  const raw = readFileSync(cfgPath, 'utf-8');

  // Minimal YAML parsing — just extract openrouter provider block
  const orMatch = raw.match(/openrouter:\s*\n\s+baseUrl:\s*(.+)\n\s+apiKey:\s*(.+)/);
  if (!orMatch) {
    console.error('Error: could not find openrouter provider in config');
    process.exit(1);
  }
  return {
    baseUrl: orMatch[1].trim(),
    apiKey: orMatch[2].trim(),
    models: [modelId],
  };
}

// ─── JSONL parsing ───────────────────────────────────────────────────────────

interface ParsedMessage {
  index: number;
  role: 'user' | 'assistant';
  text: string;
  tokenEstimate: number;
}

function parseJsonl(path: string): ParsedMessage[] {
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const msgs: ParsedMessage[] = [];

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type as string;
    if (type !== 'user' && type !== 'assistant') continue;

    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const role = message.role as string;
    if (role !== 'user' && role !== 'assistant') continue;

    const content = message.content;
    let text = '';

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const blocks = content as Array<Record<string, unknown>>;
      const textParts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text);
        }
        // Include tool_use names for context (but not full args)
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          textParts.push(`[tool: ${b.name}]`);
        }
        // Include tool_result text
        if (b.type === 'tool_result') {
          const trContent = b.content;
          if (typeof trContent === 'string') {
            textParts.push(`[tool result: ${trContent.slice(0, 500)}]`);
          } else if (Array.isArray(trContent)) {
            for (const tb of trContent as Array<Record<string, unknown>>) {
              if (tb.type === 'text' && typeof tb.text === 'string') {
                textParts.push(`[tool result: ${(tb.text as string).slice(0, 500)}]`);
              }
            }
          }
        }
      }
      text = textParts.join('\n');
    }

    if (!text.trim()) continue;

    msgs.push({
      index: msgs.length,
      role: role as 'user' | 'assistant',
      text,
      tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
    });
  }

  return msgs;
}

// ─── Build excerpt from oldest half ──────────────────────────────────────────

function buildExcerpt(msgs: ParsedMessage[], r: number, maxChars: number): { excerpt: string; coveredCount: number } {
  const cutoff = Math.floor(msgs.length * r);
  const oldest = msgs.slice(0, cutoff);

  const lines: string[] = [];
  let totalChars = 0;

  for (const m of oldest) {
    const line = `[${m.role}]: ${m.text}`;
    if (totalChars + line.length > maxChars) {
      lines.push(`[${m.role}]: ${m.text.slice(0, maxChars - totalChars)}\n... (truncated)`);
      break;
    }
    lines.push(line);
    totalChars += line.length;
  }

  return { excerpt: lines.join('\n\n'), coveredCount: oldest.length };
}

// ─── Summarize via OpenRouter ────────────────────────────────────────────────

const SUMMARIZE_SYSTEM = `You are a conversation summarizer. Given a conversation between a user and an AI assistant, produce a concise summary that preserves:

1. Key decisions made and their rationale
2. Important technical details, file paths, and code patterns discovered
3. Current state of the work — what's done, what's pending
4. Any constraints, preferences, or requirements the user stated
5. Context needed for the conversation to continue productively

Format the summary as a structured document with clear sections. Be thorough but concise — aim for roughly 2000-4000 words. The summary will replace the original messages in the context window, so anything not captured here is lost.`;

interface ChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function summarize(excerpt: string, config: ProviderConfig): Promise<{ summary: string; usage: ChatResponse['usage']; durationMs: number }> {
  const t0 = Date.now();

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: `Here is the conversation to summarize:\n\n${excerpt}` },
      ],
      max_tokens: 8192,
      temperature: 0.3,
      ...(provider ? { provider: { order: [provider] } } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }

  const data = await res.json() as ChatResponse;
  const durationMs = Date.now() - t0;
  const summary = data.choices?.[0]?.message?.content ?? '';

  return { summary, usage: data.usage, durationMs };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const jsonlPath = resolveJsonlPath();
  console.error(`Reading JSONL: ${jsonlPath}`);

  const msgs = parseJsonl(jsonlPath);
  const totalTokens = msgs.reduce((s, m) => s + m.tokenEstimate, 0);

  console.error(`Parsed ${msgs.length} messages (~${totalTokens} estimated tokens)`);
  console.error(`User: ${msgs.filter(m => m.role === 'user').length}, Assistant: ${msgs.filter(m => m.role === 'assistant').length}`);

  const { excerpt, coveredCount } = buildExcerpt(msgs, ratio, maxExcerpt);
  const excerptTokens = Math.ceil(excerpt.length / CHARS_PER_TOKEN);

  console.error(`\nExcerpt covers ${coveredCount}/${msgs.length} messages (ratio=${ratio})`);
  console.error(`Excerpt: ${excerpt.length} chars (~${excerptTokens} tokens)`);

  if (dryRun) {
    console.error('\n--- DRY RUN: Excerpt preview (first 2000 chars) ---');
    console.error(excerpt.slice(0, 2000));
    console.error('\n--- DRY RUN: Excerpt preview (last 1000 chars) ---');
    console.error(excerpt.slice(-1000));
    return;
  }

  const config = loadOpenRouterConfig();
  console.error(`\nCalling ${modelId} via ${config.baseUrl}...`);

  const { summary, usage, durationMs } = await summarize(excerpt, config);

  console.error(`\n✓ Summary received in ${(durationMs / 1000).toFixed(1)}s`);
  if (usage) {
    console.error(`  Prompt tokens: ${usage.prompt_tokens}`);
    console.error(`  Completion tokens: ${usage.completion_tokens}`);
    console.error(`  Total tokens: ${usage.total_tokens}`);
  }
  console.error(`  Summary length: ${summary.length} chars (~${Math.ceil(summary.length / CHARS_PER_TOKEN)} tokens)`);
  console.error(`  Compression ratio: ${(excerpt.length / summary.length).toFixed(1)}x`);

  // Print summary to stdout (separate from stderr diagnostics)
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(summary);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
