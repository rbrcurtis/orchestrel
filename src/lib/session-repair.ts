/**
 * Session repair — fixes structural tool_use/tool_result corruption in CC
 * session JSONL files caused by the claude-code 2.1.18+ parallel-tool write
 * race (API Error: 400 due to tool use concurrency issues).
 *
 * Corruption pattern: parallel tool calls get written as separate adjacent
 * assistant messages each with one tool_use, and their tool_results arrive
 * out of order as separate user messages. The API validates tool_use/tool_result
 * pairing per adjacent message pair, so this is rejected.
 *
 * Repair: merge runs of consecutive single-tool_use assistant messages into
 * one multi-tool_use assistant message, merge the following run of single-
 * tool_result user messages into one multi-tool_result user message with
 * results reordered to match the tool_use order.
 */
import { readdir, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

export interface RepairResult {
  sessionId: string;
  jsonlPath: string | null;
  linesBefore: number;
  linesAfter: number;
  groupsFixed: number;
  groupsSkipped: number;
  msgIdsRekeyed: number;
  dryRun: boolean;
  changed: boolean;
}

export interface RepairOpts {
  dryRun?: boolean;
}

interface ParsedEntry {
  raw: string;
  obj: Record<string, unknown>;
  type: string;
  role: 'user' | 'assistant' | null;
  toolUseIds: string[];
  toolResultIds: string[];
  hasOtherContent: boolean;
}

const UUID_RE = /^[0-9a-f-]{8,}$/i;

export async function findSessionJsonl(sessionId: string): Promise<string | null> {
  if (!UUID_RE.test(sessionId)) return null;
  const projectsDir = join(homedir(), '.claude', 'projects');
  let slugs: string[];
  try {
    slugs = await readdir(projectsDir);
  } catch {
    return null;
  }
  const filename = `${sessionId}.jsonl`;
  for (const slug of slugs) {
    const p = join(projectsDir, slug, filename);
    try {
      await readFile(p, 'utf-8');
      return p;
    } catch {
      // next
    }
  }
  return null;
}

function parseEntry(line: string): ParsedEntry | null {
  if (!line.trim()) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof obj.type === 'string' ? obj.type : '';
  const role = type === 'user' || type === 'assistant' ? type : null;

  const toolUseIds: string[] = [];
  const toolResultIds: string[] = [];
  let hasOtherContent = false;

  if (role) {
    const msg = obj.message as { content?: unknown } | undefined;
    const content = msg?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== 'object') {
          hasOtherContent = true;
          continue;
        }
        const b = c as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          toolUseIds.push(b.id);
        } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          toolResultIds.push(b.tool_use_id);
        } else {
          hasOtherContent = true;
        }
      }
    } else if (content !== undefined) {
      hasOtherContent = true;
    }
  }

  return { raw: line, obj, type, role, toolUseIds, toolResultIds, hasOtherContent };
}

/** True if entry is a pure single-tool_use assistant message. */
function isSplitAssistantUse(e: ParsedEntry): boolean {
  return (
    e.role === 'assistant' &&
    e.toolUseIds.length === 1 &&
    e.toolResultIds.length === 0 &&
    !e.hasOtherContent
  );
}

/** True if entry is a pure single-tool_result user message. */
function isSplitUserResult(e: ParsedEntry): boolean {
  return (
    e.role === 'user' &&
    e.toolResultIds.length === 1 &&
    e.toolUseIds.length === 0 &&
    !e.hasOtherContent
  );
}

/**
 * Walk role-only entries looking for split parallel-tool groups. Non-role
 * entries (attachments, queue-operation, last-prompt, compact_boundary, …)
 * are kept at their original positions since the API doesn't see them.
 *
 * Returns per-index replacement: string = emit as-is (possibly merged),
 * null = skip (subsumed by a merge).
 */
function repairEntries(entries: ParsedEntry[]): {
  lines: string[];
  groupsFixed: number;
  groupsSkipped: number;
} {
  // Build role-only index list
  const roleIdx: number[] = [];
  for (let k = 0; k < entries.length; k++) {
    if (entries[k].role) roleIdx.push(k);
  }

  // Result per original index: initially the raw line; null = drop
  const result: (string | null)[] = entries.map(e => e.raw);
  let groupsFixed = 0;
  let groupsSkipped = 0;

  let r = 0;
  while (r < roleIdx.length) {
    const origI = roleIdx[r];
    const e = entries[origI];

    if (!isSplitAssistantUse(e)) {
      r++;
      continue;
    }

    // Collect assistant run (role-only)
    let rA = r;
    while (rA < roleIdx.length && isSplitAssistantUse(entries[roleIdx[rA]])) rA++;
    const aRunRoleIdx = roleIdx.slice(r, rA);

    if (aRunRoleIdx.length < 2) {
      r++;
      continue;
    }

    // Collect user run immediately after (role-only)
    let rU = rA;
    while (rU < roleIdx.length && isSplitUserResult(entries[roleIdx[rU]])) rU++;
    const uRunRoleIdx = roleIdx.slice(rA, rU);

    const aRun = aRunRoleIdx.map(i => entries[i]);
    const uRun = uRunRoleIdx.map(i => entries[i]);

    const useIds = aRun.map(a => a.toolUseIds[0]);
    const resultIds = uRun.map(u => u.toolResultIds[0]);
    const idsMatch =
      uRun.length === aRun.length &&
      new Set(useIds).size === useIds.length &&
      useIds.every(id => resultIds.includes(id));

    if (!idsMatch) {
      r++;
      groupsSkipped++;
      continue;
    }

    // Merge assistant: place merged JSON at first assistant entry's original index,
    // drop subsequent assistant entries in the run
    const firstA = aRun[0].obj;
    const firstAMsg = { ...(firstA.message as Record<string, unknown>) };
    firstAMsg.content = aRun.map(a => (a.obj.message as { content: unknown[] }).content[0]);
    result[aRunRoleIdx[0]] = JSON.stringify({ ...firstA, message: firstAMsg });
    for (let k = 1; k < aRunRoleIdx.length; k++) result[aRunRoleIdx[k]] = null;

    // Merge user: same approach, reorder results to match use order
    const firstU = uRun[0].obj;
    const firstUMsg = { ...(firstU.message as Record<string, unknown>) };
    const resultById = new Map<string, unknown>();
    for (const u of uRun) {
      const block = (u.obj.message as { content: unknown[] }).content[0] as { tool_use_id: string };
      resultById.set(block.tool_use_id, block);
    }
    firstUMsg.content = useIds.map(id => resultById.get(id));
    result[uRunRoleIdx[0]] = JSON.stringify({ ...firstU, message: firstUMsg });
    for (let k = 1; k < uRunRoleIdx.length; k++) result[uRunRoleIdx[k]] = null;

    groupsFixed++;
    r = rU;
  }

  const lines = result.filter((l): l is string => l !== null);
  return { lines, groupsFixed, groupsSkipped };
}

/**
 * Rekey msg.id values that span compact_boundary markers. When CC reuses the
 * same assistant message.id across a compaction, its payload builder merges
 * all same-msg.id entries into one API message — producing scrambled content
 * (thinking interleaved between tool_uses from different turns) that the API
 * rejects. Fix by assigning the post-boundary entries a fresh msg.id.
 *
 * Operates on raw line strings (output of repairEntries). Returns the rekeyed
 * lines plus the count of msg.ids that were rekeyed.
 */
function rekeyCrossBoundaryMsgIds(lines: string[]): {
  lines: string[];
  msgIdsRekeyed: number;
} {
  // Parse each line once, track segment index (increments on compact_boundary)
  type Parsed = { obj: Record<string, unknown>; segment: number; msgId: string | null };
  const parsed: (Parsed | null)[] = [];
  let segment = 0;
  for (const line of lines) {
    if (!line.trim()) { parsed.push(null); continue; }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      parsed.push(null);
      continue;
    }
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      parsed.push({ obj, segment, msgId: null });
      segment++;
      continue;
    }
    const msg = obj.message as { id?: unknown } | undefined;
    const msgId = typeof msg?.id === 'string' ? msg.id : null;
    parsed.push({ obj, segment, msgId });
  }

  // msgId → set of segments it appears in
  const segByMsgId = new Map<string, Set<number>>();
  for (const p of parsed) {
    if (!p?.msgId) continue;
    if (!segByMsgId.has(p.msgId)) segByMsgId.set(p.msgId, new Set());
    segByMsgId.get(p.msgId)!.add(p.segment);
  }

  // Build replacement map: (originalMsgId, segment) → newMsgId
  // Keep the first segment's msgId; rename subsequent segments with a fresh uuid.
  const rekey = new Map<string, Map<number, string>>();
  let rekeyedCount = 0;
  for (const [msgId, segments] of segByMsgId.entries()) {
    if (segments.size < 2) continue;
    const sorted = [...segments].sort((a, b) => a - b);
    const perSegment = new Map<number, string>();
    for (let i = 1; i < sorted.length; i++) {
      perSegment.set(sorted[i], randomUUID());
    }
    rekey.set(msgId, perSegment);
    rekeyedCount++;
  }

  if (rekeyedCount === 0) return { lines, msgIdsRekeyed: 0 };

  // Rewrite lines with replaced msg.id
  const out: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (!p || !p.msgId || !rekey.has(p.msgId)) {
      out.push(lines[i]);
      continue;
    }
    const newId = rekey.get(p.msgId)!.get(p.segment);
    if (!newId) {
      // First segment — keep original
      out.push(lines[i]);
      continue;
    }
    const msg = { ...(p.obj.message as Record<string, unknown>), id: newId };
    out.push(JSON.stringify({ ...p.obj, message: msg }));
  }

  return { lines: out, msgIdsRekeyed: rekeyedCount };
}

export async function repairSession(
  sessionId: string,
  opts: RepairOpts = {},
): Promise<RepairResult> {
  const dryRun = opts.dryRun ?? false;
  const jsonlPath = await findSessionJsonl(sessionId);

  if (!jsonlPath) {
    return {
      sessionId,
      jsonlPath: null,
      linesBefore: 0,
      linesAfter: 0,
      groupsFixed: 0,
      groupsSkipped: 0,
      msgIdsRekeyed: 0,
      dryRun,
      changed: false,
    };
  }

  const raw = await readFile(jsonlPath, 'utf-8');
  const rawLines = raw.split('\n');
  const entries: ParsedEntry[] = [];
  for (const line of rawLines) {
    const e = parseEntry(line);
    if (e) entries.push(e);
  }

  const { lines: mergedLines, groupsFixed, groupsSkipped } = repairEntries(entries);
  const { lines: finalLines, msgIdsRekeyed } = rekeyCrossBoundaryMsgIds(mergedLines);
  const changed = groupsFixed > 0 || msgIdsRekeyed > 0;

  if (changed && !dryRun) {
    const tmp = `${jsonlPath}.repair.tmp`;
    await writeFile(tmp, finalLines.join('\n') + '\n', 'utf-8');
    await rename(tmp, jsonlPath);
  }

  return {
    sessionId,
    jsonlPath,
    linesBefore: entries.length,
    linesAfter: finalLines.length,
    groupsFixed,
    groupsSkipped,
    msgIdsRekeyed,
    dryRun,
    changed,
  };
}
