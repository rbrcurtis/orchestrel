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
 * Conversion is pragmatic and lossy on tool-call *structure*: tool_use /
 * tool_result blocks are flattened into readable text rather than reconstructed
 * as Pi `toolResult`-role messages. This preserves the *content* the model needs
 * to pick up context (verified: imported sessions recall prior tool outputs),
 * without the fragile job of re-pairing tool calls across the role split. Turns
 * are linearized into a single branch — each kept entry chains to the previous
 * kept entry, so dropped lines (sidechains, meta, queue ops) never leave broken
 * parent pointers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Message, TextContent } from '@earendil-works/pi-ai';

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

/** Flatten a Claude content block array into plain text, recording tool names. */
function blocksToText(blocks: ClaudeBlock[], toolNames: Map<string, string>): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      parts.push(b.text);
    } else if (b.type === 'thinking' && b.thinking) {
      parts.push(`[thinking]\n${b.thinking}`);
    } else if (b.type === 'tool_use') {
      if (b.id && b.name) toolNames.set(b.id, b.name);
      parts.push(`[tool call: ${b.name ?? 'tool'}] ${JSON.stringify(b.input ?? {})}`);
    } else if (b.type === 'tool_result') {
      const name = b.tool_use_id ? toolNames.get(b.tool_use_id) ?? 'tool' : 'tool';
      let txt = '';
      if (typeof b.content === 'string') txt = b.content;
      else if (Array.isArray(b.content)) {
        txt = (b.content as { text?: string }[]).map((c) => c?.text ?? '').join('\n');
      }
      parts.push(`[tool result: ${name}${b.is_error ? ' ERROR' : ''}]\n${txt}`);
    }
  }
  return parts.join('\n\n').trim();
}

function lineToText(line: ClaudeLine, toolNames: Map<string, string>): string {
  const content = line.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return blocksToText(content as ClaudeBlock[], toolNames);
  return '';
}

export interface BuiltSession {
  sessionId: string;
  cwd: string;
  messages: Message[];
}

/**
 * Parse a Claude transcript into preserved-id Pi messages without writing.
 * @param overrideSessionId Use this id instead of the transcript's own.
 * @param overrideCwd Use this cwd instead of the one recorded in the transcript.
 */
export function buildPiSession(jsonlPath: string, overrideSessionId?: string, overrideCwd?: string): BuiltSession {
  const lines = parseLines(jsonlPath);

  const sessionId = overrideSessionId ?? lines.find((l) => l.sessionId)?.sessionId ?? path.basename(jsonlPath, '.jsonl');
  const cwd = overrideCwd ?? lines.find((l) => typeof l.cwd === 'string' && l.cwd)?.cwd;
  if (!cwd) throw new Error('cwd not found in transcript; pass an explicit cwd');

  const toolNames = new Map<string, string>();
  const messages: Message[] = [];
  let lastRole: 'user' | 'assistant' | null = null;

  for (const line of lines) {
    if (line.isSidechain || line.isMeta) continue;
    if (line.type !== 'user' && line.type !== 'assistant') continue;
    if (!line.message) continue;
    const role = line.type;
    const text = lineToText(line, toolNames);
    if (!text) continue;
    const ts = line.timestamp ? Date.parse(line.timestamp) : Date.now();

    // Collapse consecutive same-role turns so the branch alternates cleanly.
    if (role === lastRole) {
      const prev = messages[messages.length - 1];
      if (prev.role === 'user' && typeof prev.content === 'string') prev.content += `\n\n${text}`;
      else if (prev.role === 'assistant') (prev.content[0] as TextContent).text += `\n\n${text}`;
      continue;
    }

    if (role === 'user') {
      messages.push({ role: 'user', content: text, timestamp: ts });
    } else {
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: line.message.model ?? 'claude-sonnet-4-6',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: ts,
      };
      messages.push(assistant);
    }
    lastRole = role;
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
