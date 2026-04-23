/**
 * Session compactor — compacts old messages in a Claude Code session JSONL file
 * by summarizing the oldest portion and rewriting the file atomically.
 */
import { readFile, writeFile, rename, realpath } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const CHARS_PER_TOKEN = 3.5;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CompactResult {
  sessionId: string;
  jsonlPath: string;
  messagesBefore: number;
  messagesCovered: number;
  summaryTokens: number;
  summaryChars: number;
  durationMs: number;
}

export interface CompactOpts {
  sessionId: string;
  projectPath: string;
  model: string;
  env?: Record<string, string>;
  ratio?: number;
  maxExcerptChars?: number;
  dryRun?: boolean;
}

/** A parsed message with its original line index */
export interface IndexedMessage {
  lineIndex: number;
  role: 'user' | 'assistant';
  text: string;
  isToolResult: boolean;
  isToolUse: boolean;
}


// ─── JSONL path resolution ──────────────────────────────────────────────────

export function computeSlug(realPath: string): string {
  return realPath.replace(/[^a-zA-Z0-9]/g, '-');
}

export async function resolveJsonlPath(sessionId: string, projectPath: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(projectPath);
  } catch {
    // Worktree may have been deleted — use path as-is for slug computation
    real = projectPath;
  }
  const slug = computeSlug(real);
  return join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

// ─── JSONL parsing ──────────────────────────────────────────────────────────

export function parseLines(lines: string[]): { lastBoundaryLine: number; messages: IndexedMessage[] } {
  let lastBoundaryLine = -1;
  const messages: IndexedMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Track compact_boundary markers
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      lastBoundaryLine = i;
      messages.length = 0; // reset — only care about messages after last boundary
      continue;
    }

    if (obj.type !== 'user' && obj.type !== 'assistant') continue;

    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const role = message.role as string;
    if (role !== 'user' && role !== 'assistant') continue;

    const content = message.content;
    const text = extractText(content);
    if (!text.trim()) continue;

    // Detect tool_result / tool_use content blocks for boundary snapping
    const blocks = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
    const isToolResult = blocks.some(b => b.type === 'tool_result');
    const isToolUse = blocks.some(b => b.type === 'tool_use');

    messages.push({ lineIndex: i, role: role as 'user' | 'assistant', text, isToolResult, isToolUse });
  }

  return { lastBoundaryLine, messages };
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;

  if (!Array.isArray(content)) return '';

  const blocks = content as Array<Record<string, unknown>>;
  const parts: string[] = [];

  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      parts.push(`[tool: ${b.name}]`);
    }
    if (b.type === 'tool_result') {
      const c = b.content;
      if (typeof c === 'string') {
        parts.push(`[tool result: ${c.slice(0, 500)}]`);
      } else if (Array.isArray(c)) {
        for (const tb of c as Array<Record<string, unknown>>) {
          if (tb.type === 'text' && typeof tb.text === 'string') {
            parts.push(`[tool result: ${(tb.text as string).slice(0, 500)}]`);
          }
        }
      }
    }
  }

  return parts.join('\n');
}

// ─── Excerpt building ───────────────────────────────────────────────────────

export function buildExcerpt(msgs: IndexedMessage[], maxChars: number): string {
  const parts: string[] = [];
  let total = 0;

  for (const m of msgs) {
    const text = m.text.length > 3000 ? m.text.slice(0, 3000) : m.text;
    const line = `[${m.role}]: ${text}`;

    if (total + line.length > maxChars) {
      const remaining = maxChars - total;
      if (remaining > 100) {
        parts.push(line.slice(0, remaining) + '\n... (truncated)');
      }
      break;
    }

    parts.push(line);
    total += line.length;
  }

  return parts.join('\n\n');
}

// ─── Agent SDK query (shared by compactor + memory-upsert) ─────────────────

import type { Options } from '@anthropic-ai/claude-agent-sdk';

/**
 * Options for `queryAgentSdk`. All tool-related fields default to fully
 * locked down — callers must explicitly opt in to any tool surface.
 *
 * Locked-down defaults exist because maxTurns:1 + tool access is a known
 * failure mode: a hallucinated tool call aborts the response and returns
 * whatever pre-tool text existed (see card 902 session 5ea9184c — produced
 * 90-char garbage summary). Callers who legitimately need tools MUST also
 * raise `maxTurns` accordingly.
 */
export interface QueryAgentSdkOpts {
  env?: Record<string, string>;
  /** Built-in tool allowlist. Default: `[]` (no built-ins). */
  tools?: Options['tools'];
  /** MCP servers available to the model. Default: `{}` (none). */
  mcpServers?: Options['mcpServers'];
  /**
   * Settings source inheritance. Default: `[]` — ignore user / project
   * settings so behaviour is reproducible and tool surfaces don't leak in
   * via `~/.claude/settings.json`.
   */
  settingSources?: Options['settingSources'];
  /** Default: 1. Raise only when the caller needs multi-turn tool use. */
  maxTurns?: number;
  /** Default: disabled. */
  thinking?: Options['thinking'];
}

/**
 * Run an Agent SDK query and return the assistant's text response.
 * Locked-down by default (no tools, no MCP, no settings, no thinking,
 * maxTurns 1). Callers may override any of these via opts.
 */
export async function queryAgentSdk(
  prompt: string,
  model: string,
  opts: QueryAgentSdkOpts = {},
): Promise<{ text: string; durationMs: number }> {
  const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk');
  const t0 = Date.now();

  const q = sdkQuery({
    prompt,
    options: {
      model,
      maxTurns: opts.maxTurns ?? 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: '/home/ryan/.local/bin/claude',
      tools: opts.tools ?? [],
      mcpServers: opts.mcpServers ?? {},
      settingSources: opts.settingSources ?? [],
      thinking: opts.thinking ?? { type: 'disabled' },
      ...(opts.env ? { env: opts.env } : {}),
    },
  });

  let result = '';
  for await (const event of q) {
    const e = event as Record<string, unknown>;
    if (e.type === 'assistant') {
      const msg = e.message as Record<string, unknown> | undefined;
      if (msg?.content) {
        const text = extractText(msg.content);
        if (text) result = text;
      }
    }
  }

  if (!result) {
    throw new Error('Agent SDK query returned no assistant text');
  }

  return { text: result, durationMs: Date.now() - t0 };
}

// ─── Version detection ─────────────────────────────────────────────────────

function findVersion(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.version === 'string') return obj.version;
    } catch { /* skip */ }
  }
  return '2.1.108'; // fallback
}

// ─── Two-phase compaction ───────────────────────────────────────────────────

/** Prepared compaction — summary is ready, waiting to be applied at a safe point */
export interface PreparedCompaction {
  sessionId: string;
  jsonlPath: string;
  summary: string;
  /** Line index of the last message covered by the summary */
  lastOldLineIdx: number;
  messagesBefore: number;
  messagesCovered: number;
  summaryChars: number;
  prepareDurationMs: number;
}

/**
 * Phase 1: Prepare — reads JSONL, summarizes oldest half via Agent SDK.
 * Returns the summary + metadata. Does NOT write to disk.
 * Safe to run while the session is active (read-only).
 *
 * Thin wrapper over `summarizeSession` (src/lib/summarize-session.ts) that
 * adapts the result shape for applyCompaction.
 */
export async function prepareCompaction(opts: CompactOpts): Promise<PreparedCompaction> {
  const { summarizeSession } = await import('./summarize-session');
  const jsonlPath = await resolveJsonlPath(opts.sessionId, opts.projectPath);
  const r = await summarizeSession(opts.sessionId, opts.model, {
    env: opts.env,
    ratio: opts.ratio,
    maxExcerptChars: opts.maxExcerptChars,
    dryRun: opts.dryRun,
    jsonlPath,
  });

  return {
    sessionId: r.sessionId,
    jsonlPath: r.jsonlPath,
    summary: r.summary,
    lastOldLineIdx: r.lastOldLineIdx,
    messagesBefore: r.messagesBefore,
    messagesCovered: r.messagesCovered,
    summaryChars: opts.dryRun ? r.excerptChars : r.summaryChars,
    prepareDurationMs: r.durationMs,
  };
}

/**
 * Phase 2: Apply — re-reads the JSONL and splices in the boundary + summary.
 * Any new messages appended since prepare are preserved.
 * Instant (no LLM call). Call only when the session is idle.
 */
export async function applyCompaction(prepared: PreparedCompaction): Promise<CompactResult> {
  const { sessionId, jsonlPath, summary, lastOldLineIdx } = prepared;

  // Re-read the file — it may have grown since prepare
  const raw = await readFile(jsonlPath, 'utf-8');
  const lines = raw.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  // Sanity check: the cutoff line should still exist and match
  if (lastOldLineIdx >= lines.length) {
    throw new Error(`JSONL shrank since prepare: expected line ${lastOldLineIdx} but file has ${lines.length} lines`);
  }

  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const now = new Date().toISOString();

  const lastOldLine = lines[lastOldLineIdx];
  const lastOldObj = JSON.parse(lastOldLine) as Record<string, unknown>;
  const lastOldUuid = lastOldObj.uuid as string;

  const boundaryEntry = JSON.stringify({
    parentUuid: null,
    logicalParentUuid: lastOldUuid,
    isSidechain: false,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: now,
    uuid: boundaryUuid,
  });

  const summaryEntry = JSON.stringify({
    parentUuid: boundaryUuid,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: `[Context Summary — the following summarizes the earlier part of this conversation]\n\n${summary}`,
    },
    uuid: summaryUuid,
    timestamp: now,
    sessionId,
    version: findVersion(lines),
  });

  // 1. All original lines up to and including lastOldLineIdx
  const outLines: string[] = lines.slice(0, lastOldLineIdx + 1);

  // 2. compact_boundary + summary
  outLines.push(boundaryEntry);
  outLines.push(summaryEntry);

  // 3. Remaining lines (including any new ones added since prepare), first one reparented
  const remaining = lines.slice(lastOldLineIdx + 1);
  let reparented = false;

  for (let i = 0; i < remaining.length; i++) {
    if (reparented) {
      outLines.push(remaining[i]);
      continue;
    }

    const trimmed = remaining[i].trim();
    if (!trimmed) {
      outLines.push(remaining[i]);
      continue;
    }

    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      obj.parentUuid = summaryUuid;
      outLines.push(JSON.stringify(obj));
      reparented = true;
    } catch {
      outLines.push(remaining[i]);
    }
  }

  const tmpPath = jsonlPath + '.compact-tmp';
  await writeFile(tmpPath, outLines.join('\n') + '\n');
  await rename(tmpPath, jsonlPath);

  return {
    sessionId,
    jsonlPath,
    messagesBefore: prepared.messagesBefore,
    messagesCovered: prepared.messagesCovered,
    summaryTokens: Math.ceil(prepared.summaryChars / CHARS_PER_TOKEN),
    summaryChars: prepared.summaryChars,
    durationMs: prepared.prepareDurationMs,
  };
}

/**
 * One-shot compaction (prepare + apply in one call).
 * Only safe for offline use (CLI script) — not for live sessions.
 */
export async function compactSession(opts: CompactOpts): Promise<CompactResult> {
  const prepared = await prepareCompaction(opts);
  if (opts.dryRun) {
    return {
      sessionId: prepared.sessionId,
      jsonlPath: prepared.jsonlPath,
      messagesBefore: prepared.messagesBefore,
      messagesCovered: prepared.messagesCovered,
      summaryTokens: 0,
      summaryChars: prepared.summaryChars,
      durationMs: 0,
    };
  }
  return applyCompaction(prepared);
}
