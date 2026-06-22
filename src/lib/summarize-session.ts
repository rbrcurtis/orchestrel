/**
 * Atomic session summarization preview.
 *
 * Reads Pi session history, determines a tool-use/tool-result-safe cut point,
 * and builds the excerpt that active-session compaction would summarize.
 *
 * Pure: does NOT edit session state. Runtime compaction is delegated to active
 * Pi sessions through orcd.
 */
import { getPiSessionMessages } from './pi-session-history';
import { parseLines, buildExcerpt } from './session-compactor';

const CHARS_PER_TOKEN = 3.5;

export interface SummarizeOpts {
  /** Project working directory used to locate Pi session history. Defaults to cwd. */
  projectPath?: string;
  /** Fraction of oldest messages to summarize. Default 0.5. */
  ratio?: number;
  /** Cap on excerpt size sent to the model. Default 120_000 chars. */
  maxExcerptChars?: number;
  /** If true, build the excerpt but do not request compaction. Returns summary=''. */
  dryRun?: boolean;
}

export interface SummarizeResult {
  sessionId: string;
  /** Source identifier for the loaded session history. */
  jsonlPath: string;
  /** The generated summary text. Empty if dryRun. */
  summary: string;
  /** Line index of the last message covered by the summary. */
  lastOldLineIdx: number;
  /** Total parseable messages after the last compact boundary. */
  messagesBefore: number;
  /** Number of messages covered by the summary (the cutoff). */
  messagesCovered: number;
  /** Character length of the excerpt sent to the model. */
  excerptChars: number;
  /** Character length of the returned summary. */
  summaryChars: number;
  /** Estimated tokens in the summary. */
  summaryTokens: number;
  /** How long the model call took. 0 on dryRun. */
  durationMs: number;
}

// ─── Cutoff selection ───────────────────────────────────────────────────────

/**
 * Pick the cutoff index: floor(count * ratio), then snap backward so the
 * boundary never falls between a tool_use and its matching tool_result.
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
 * Summarize a session by id. Reads Pi session history, picks a tool-boundary-safe
 * cutoff, and returns metadata needed to preview the compaction. Runtime
 * compaction must happen through an active orcd session.
 */
export async function summarizeSession(
  sessionId: string,
  _model: string,
  opts: SummarizeOpts = {},
): Promise<SummarizeResult> {
  const ratio = opts.ratio ?? 0.5;
  const maxExcerptChars = opts.maxExcerptChars ?? 120_000;
  const cwd = opts.projectPath ?? process.cwd();

  const history = await getPiSessionMessages(sessionId, cwd);
  if (history.length === 0) {
    throw new Error(`No Pi session history found for session ${sessionId} in ${cwd}`);
  }

  const lines = history.map((msg) => JSON.stringify(msg));
  const { messages } = parseLines(lines);
  const cutoff = selectCutoff(messages, ratio);

  const oldestHalf = messages.slice(0, cutoff);
  const excerpt = buildExcerpt(oldestHalf, maxExcerptChars);
  const lastOldLineIdx = oldestHalf[oldestHalf.length - 1].lineIndex;

  if (!(opts.dryRun ?? false)) {
    throw new Error('Manual summary generation has been removed; compact active Pi sessions through orcd');
  }

  return {
    sessionId,
    jsonlPath: `pi:${cwd}:${sessionId}`,
    summary: '',
    lastOldLineIdx,
    messagesBefore: messages.length,
    messagesCovered: cutoff,
    excerptChars: excerpt.length,
    summaryChars: 0,
    summaryTokens: Math.ceil(0 / CHARS_PER_TOKEN),
    durationMs: 0,
  };
}
