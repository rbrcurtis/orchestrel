/**
 * Atomic session summarization.
 *
 * Given only a Claude Code session ID, reads the JSONL file, determines the
 * cut point (tool-use/tool-result aware), builds an excerpt, and calls the
 * Agent SDK to produce a summary.
 *
 * Pure: does NOT edit the JSONL. Intended as the testable core of the
 * background compactor — callable standalone for quality/regression testing
 * against any past session.
 */
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { parseLines, buildExcerpt, queryAgentSdk } from './session-compactor';

const CHARS_PER_TOKEN = 3.5;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SummarizeOpts {
  /** Env passed to the Agent SDK subprocess (provider routing, API keys). */
  env?: Record<string, string>;
  /** Fraction of oldest messages to summarize. Default 0.5. */
  ratio?: number;
  /** Cap on excerpt size sent to the model. Default 120_000 chars. */
  maxExcerptChars?: number;
  /** If true, build the excerpt but skip the SDK call. Returns summary=''. */
  dryRun?: boolean;
  /** Minimum summary length (defensive). Throws if shorter. Default 500. */
  minSummaryChars?: number;
  /**
   * Override the JSONL path instead of auto-locating by session id. Useful
   * when the same session has forked across multiple JSONL files and you
   * want to point at a specific one.
   */
  jsonlPath?: string;
}

export interface SummarizeResult {
  sessionId: string;
  jsonlPath: string;
  /** The generated summary text. Empty if dryRun. */
  summary: string;
  /** Line index of the last message covered by the summary, in the JSONL. */
  lastOldLineIdx: number;
  /** Total parseable messages in the JSONL (after last compact_boundary). */
  messagesBefore: number;
  /** Number of messages covered by the summary (the cutoff). */
  messagesCovered: number;
  /** Character length of the excerpt sent to the model. */
  excerptChars: number;
  /** Character length of the returned summary. */
  summaryChars: number;
  /** Estimated tokens in the summary. */
  summaryTokens: number;
  /** How long the Agent SDK call took. 0 on dryRun. */
  durationMs: number;
}

// ─── JSONL lookup ───────────────────────────────────────────────────────────

/**
 * Locate a session JSONL by id alone. Scans every project directory under
 * ~/.claude/projects for `${sessionId}.jsonl`. Throws if not found.
 *
 * If multiple match (fork across projects), returns the most recently
 * modified one.
 */
export async function findJsonlBySessionId(sessionId: string): Promise<string> {
  const projectsDir = join(homedir(), '.claude', 'projects');
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch (err) {
    throw new Error(`Cannot read ${projectsDir}: ${err instanceof Error ? err.message : err}`);
  }

  const matches: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const path = join(projectsDir, entry, `${sessionId}.jsonl`);
    try {
      const s = await stat(path);
      if (s.isFile()) matches.push({ path, mtimeMs: s.mtimeMs });
    } catch { /* not found in this project — skip */ }
  }

  if (matches.length === 0) {
    throw new Error(`No JSONL found for session ${sessionId} under ${projectsDir}`);
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0].path;
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const SUMMARIZE_PROMPT = `You are a conversation summarizer. Do not use any tools. Do not read any files. Respond with ONLY the summary text.

Given the following conversation between a user and an AI assistant, produce a concise summary that preserves:

1. Key decisions made and their rationale
2. Important technical details, file paths, and code patterns discovered
3. Current state of the work — what's done, what's pending
4. Any constraints, preferences, or requirements the user stated
5. Context needed for the conversation to continue productively

Format the summary as a structured document with clear sections. Be thorough but concise — aim for roughly 2000-4000 words. The summary will replace the original messages in the context window, so anything not captured here is lost.

Here is the conversation to summarize:

`;

// ─── Cutoff selection ───────────────────────────────────────────────────────

/**
 * Pick the cutoff index: floor(count * ratio), then snap backward so the
 * boundary never falls between a tool_use and its matching tool_result (the
 * API rejects orphaned tool_result entries).
 */
export function selectCutoff(
  messages: Array<{ isToolResult: boolean; isToolUse: boolean }>,
  ratio: number,
): number {
  let cutoff = Math.floor(messages.length * ratio);
  if (cutoff < 2) {
    throw new Error(`Too few messages to summarize: ${messages.length} messages, cutoff=${cutoff}`);
  }
  while (cutoff > 2) {
    const firstKept = messages[cutoff];
    const lastSummarized = messages[cutoff - 1];
    if (firstKept.isToolResult || lastSummarized.isToolUse) {
      cutoff--;
    } else {
      break;
    }
  }
  return cutoff;
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Summarize a session by id. Reads the JSONL, picks a tool-boundary-safe
 * cutoff, calls the Agent SDK with a toolless one-turn query, and returns
 * the summary + all metadata needed to apply it. Does NOT mutate anything.
 */
export async function summarizeSession(
  sessionId: string,
  model: string,
  opts: SummarizeOpts = {},
): Promise<SummarizeResult> {
  const ratio = opts.ratio ?? 0.5;
  const maxExcerptChars = opts.maxExcerptChars ?? 120_000;
  const minSummaryChars = opts.minSummaryChars ?? 500;
  const dryRun = opts.dryRun ?? false;

  const jsonlPath = opts.jsonlPath ?? await findJsonlBySessionId(sessionId);

  const raw = await readFile(jsonlPath, 'utf-8');
  const lines = raw.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const { messages } = parseLines(lines);
  const cutoff = selectCutoff(messages, ratio);

  const oldestHalf = messages.slice(0, cutoff);
  const excerpt = buildExcerpt(oldestHalf, maxExcerptChars);
  const lastOldLineIdx = oldestHalf[oldestHalf.length - 1].lineIndex;

  if (dryRun) {
    return {
      sessionId,
      jsonlPath,
      summary: '',
      lastOldLineIdx,
      messagesBefore: messages.length,
      messagesCovered: cutoff,
      excerptChars: excerpt.length,
      summaryChars: 0,
      summaryTokens: 0,
      durationMs: 0,
    };
  }

  // Explicit locked-down options: no tools, no MCP, no settings, no
  // thinking, single turn. Pure text-in / text-out for determinism and
  // to avoid tool-call-hallucination truncation.
  const { text: summary, durationMs } = await queryAgentSdk(
    SUMMARIZE_PROMPT + excerpt,
    model,
    {
      env: opts.env,
      tools: [],
      mcpServers: {},
      settingSources: [],
      maxTurns: 1,
      thinking: { type: 'disabled' },
    },
  );

  if (summary.length < minSummaryChars) {
    throw new Error(
      `Summary too short (${summary.length} chars < ${minSummaryChars}). ` +
      `Likely a model failure (tool-call hallucination, refusal, or truncation). ` +
      `Raw summary: ${JSON.stringify(summary)}`,
    );
  }

  return {
    sessionId,
    jsonlPath,
    summary,
    lastOldLineIdx,
    messagesBefore: messages.length,
    messagesCovered: cutoff,
    excerptChars: excerpt.length,
    summaryChars: summary.length,
    summaryTokens: Math.ceil(summary.length / CHARS_PER_TOKEN),
    durationMs,
  };
}
