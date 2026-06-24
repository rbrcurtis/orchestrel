/* oxlint-disable orchestrel/log-before-early-return, orchestrel/log-in-catch -- pure transcript-conversion helpers: guard clauses and skip-malformed fallbacks have no session context to log */
/**
 * Import a Claude Code `.jsonl` transcript into a Pi session so a conversation
 * started under the Agent SDK can be resumed under the Pi harness.
 *
 * The Claude session id is preserved as the Pi session id, so an orchestrel
 * card's `session_id` keeps pointing at the same conversation after migration —
 * no DB update needed, and orcd's resume path (SessionManager.list → open by id)
 * finds it.
 *
 * Tool calls are reconstructed faithfully — `tool_use` → Pi `toolCall` content
 * blocks, `tool_result` → standalone Pi `toolResult` messages, ids paired (see
 * buildPiSession). An earlier version flattened tool calls into `[tool call: …]`
 * text; the model then in-context-learned that pattern and emitted tool calls as
 * plain text, so nothing executed and turns ended immediately. Turns are
 * linearized into a single branch, and dropped lines (sidechains, meta, queue
 * ops) never leave broken parent pointers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Message, TextContent, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface ClaudeBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
}

interface ClaudeLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown; model?: string };
}

export interface ImportResult {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  messageCount: number;
}

/** Find a Claude transcript file by session id under ~/.claude/projects/**. */
export function findClaudeTranscript(sessionId: string): string | undefined {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return undefined;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function parseLines(jsonlPath: string): ClaudeLine[] {
  const out: ClaudeLine[] = [];
  for (const ln of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    try {
      out.push(JSON.parse(ln) as ClaudeLine);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/**
 * Claude transcripts are a tree linked by uuid/parentUuid; file order is NOT
 * logical order (async tool logging interleaves writes — a tool_result line can
 * be written before its tool_use line). Reconstruct the real conversation order
 * by walking the parent chain from the most-recent leaf back to the root, like
 * Pi's own buildSessionContext. This follows the active branch and drops
 * abandoned (edited-away) branches.
 */
function orderByTree(lines: ClaudeLine[]): ClaudeLine[] {
  const byUuid = new Map<string, ClaudeLine>();
  for (const l of lines) if (l.uuid) byUuid.set(l.uuid, l);
  const parents = new Set<string>();
  for (const l of lines) if (l.parentUuid) parents.add(l.parentUuid);

  const leaves = lines
    .filter((l) => l.uuid && !parents.has(l.uuid) && !l.isSidechain && !l.isMeta && (l.type === 'user' || l.type === 'assistant'))
    .sort((a, b) => (Date.parse(b.timestamp ?? '') || 0) - (Date.parse(a.timestamp ?? '') || 0));
  const leaf = leaves[0];
  if (!leaf) return lines; // no uuid metadata — fall back to file order

  const chain: ClaudeLine[] = [];
  const seen = new Set<string>();
  let cur: ClaudeLine | undefined = leaf;
  while (cur) {
    if (cur.uuid) {
      if (seen.has(cur.uuid)) break; // cycle guard
      seen.add(cur.uuid);
    }
    chain.push(cur);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  return chain.reverse();
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return (content as { type?: string; text?: string }[]).map((c) => (c?.type === 'text' ? c.text ?? '' : '')).join('\n');
  return '';
}

function makeAssistant(content: (TextContent | ToolCall)[], model: string | undefined, ts: number): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: model ?? 'claude-sonnet-4-6',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: ts,
  };
}

export interface BuiltSession {
  sessionId: string;
  cwd: string;
  messages: Message[];
}

/**
 * Parse a Claude transcript into preserved-id Pi messages without writing.
 *
 * Tool calls are reconstructed FAITHFULLY, not flattened to text: Claude
 * `tool_use` blocks become Pi `toolCall` content blocks and `tool_result`
 * blocks become standalone Pi `toolResult` messages, with ids paired. Flattening
 * to `[tool call: ...]` text was a real bug — the model in-context-learned that
 * pattern and emitted tool calls as plain text, so nothing executed and turns
 * ended immediately. To keep Anthropic's tool_use/tool_result pairing valid, a
 * tool_use is only kept when a matching tool_result exists later (and vice
 * versa); unpaired ones are dropped. `thinking` blocks are dropped (their stale
 * signatures can't be replayed).
 *
 * @param overrideSessionId Use this id instead of the transcript's own.
 * @param overrideCwd Use this cwd instead of the one recorded in the transcript.
 */
export function buildPiSession(jsonlPath: string, overrideSessionId?: string, overrideCwd?: string): BuiltSession {
  const lines = parseLines(jsonlPath);

  const sessionId = overrideSessionId ?? lines.find((l) => l.sessionId)?.sessionId ?? path.basename(jsonlPath, '.jsonl');
  const cwd = overrideCwd ?? lines.find((l) => typeof l.cwd === 'string' && l.cwd)?.cwd;
  if (!cwd) throw new Error('cwd not found in transcript; pass an explicit cwd');

  const kept = orderByTree(lines).filter((l) => !l.isSidechain && !l.isMeta && (l.type === 'user' || l.type === 'assistant') && l.message);

  // Prescan: only keep tool_use/tool_result pairs where BOTH sides are present,
  // so Anthropic's pairing requirement holds.
  const useIds = new Set<string>();
  const resultIds = new Set<string>();
  const toolNames = new Map<string, string>();
  for (const line of kept) {
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as ClaudeBlock[]) {
      if (b.type === 'tool_use' && b.id) {
        useIds.add(b.id);
        if (b.name) toolNames.set(b.id, b.name);
      } else if (b.type === 'tool_result' && b.tool_use_id) {
        resultIds.add(b.tool_use_id);
      }
    }
  }
  const paired = (id: string | undefined): boolean => !!id && useIds.has(id) && resultIds.has(id);

  const messages: Message[] = [];
  for (const line of kept) {
    const role = line.type as 'user' | 'assistant';
    const ts = line.timestamp ? Date.parse(line.timestamp) : Date.now();
    const content = line.message?.content;

    if (role === 'assistant') {
      const blocks: (TextContent | ToolCall)[] = [];
      if (typeof content === 'string') {
        if (content.trim()) blocks.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const b of content as ClaudeBlock[]) {
          if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
          else if (b.type === 'tool_use' && paired(b.id)) blocks.push({ type: 'toolCall', id: b.id!, name: b.name ?? 'tool', arguments: (b.input as Record<string, unknown>) ?? {} });
        }
      }
      if (blocks.length === 0) continue;
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant') prev.content.push(...blocks);
      else messages.push(makeAssistant(blocks, line.message?.model, ts));
      continue;
    }

    // user role: tool_result blocks become toolResult messages; text becomes a user message
    if (typeof content === 'string') {
      if (content.trim()) messages.push({ role: 'user', content, timestamp: ts });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const textParts: string[] = [];
    for (const b of content as ClaudeBlock[]) {
      if (b.type === 'text' && b.text) textParts.push(b.text);
      else if (b.type === 'tool_result' && paired(b.tool_use_id)) {
        const tr: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: b.tool_use_id!,
          toolName: toolNames.get(b.tool_use_id!) ?? 'tool',
          content: [{ type: 'text', text: toolResultText(b.content) }],
          isError: !!b.is_error,
          timestamp: ts,
        };
        messages.push(tr);
      }
    }
    if (textParts.length) {
      const text = textParts.join('\n\n');
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'user' && typeof prev.content === 'string') prev.content += `\n\n${text}`;
      else messages.push({ role: 'user', content: text, timestamp: ts });
    }
  }

  return { sessionId, cwd, messages };
}

/** Pi encodes a cwd into its sessions dir name as `--<path with / -> ->--`. */
function piSessionDir(cwd: string): string {
  const enc = `--${cwd.replace(/\//g, '-').replace(/^-/, '')}--`;
  return path.join(os.homedir(), '.pi', 'agent', 'sessions', enc);
}

/** Remove any existing Pi session file carrying this id (idempotent re-import). */
function removeExisting(cwd: string, sessionId: string): void {
  const dir = piSessionDir(cwd);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    try {
      const first = fs.readFileSync(full, 'utf8').split('\n', 1)[0];
      if (first && (JSON.parse(first) as { id?: string }).id === sessionId) fs.unlinkSync(full);
    } catch {
      // ignore unreadable files
    }
  }
}

/**
 * Convert a Claude transcript and write it as a Pi session (id preserved).
 * Resolves the transcript by explicit `file` or by `sessionId` lookup.
 */
export function importClaudeSession(opts: { file?: string; sessionId?: string; cwd?: string }): ImportResult {
  const jsonlPath = opts.file ?? (opts.sessionId ? findClaudeTranscript(opts.sessionId) : undefined);
  if (!jsonlPath) throw new Error(`Claude transcript not found (session ${opts.sessionId ?? '?'})`);
  if (!fs.existsSync(jsonlPath)) throw new Error(`Claude transcript does not exist: ${jsonlPath}`);

  const built = buildPiSession(jsonlPath, opts.sessionId, opts.cwd);
  if (built.messages.length === 0) throw new Error('transcript produced no messages');

  removeExisting(built.cwd, built.sessionId);
  const sm = SessionManager.create(built.cwd, undefined, { id: built.sessionId });
  for (const m of built.messages) sm.appendMessage(m);

  const sessionFile = sm.getSessionFile();
  if (!sessionFile) throw new Error('session was not persisted');
  return { sessionId: built.sessionId, sessionFile, cwd: built.cwd, messageCount: built.messages.length };
}
