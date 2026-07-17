#!/usr/bin/env bun
/**
 * Migrate Claude Code JSONL sessions to Pi session format (v3).
 *
 * Keeps the same session ID so cards.session_id stays valid — orcd resolves
 * Pi sessions by header id via SessionManager.list().
 *
 * Usage:
 *   bun scripts/migrate-claude-session.ts --board [--dry-run]   # all non-archive cards with sessions
 *   bun scripts/migrate-claude-session.ts --session <uuid> [--dry-run]
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const board = argv.includes('--board');
const sidx = argv.indexOf('--session');
const singleSession = sidx !== -1 ? argv[sidx + 1] : undefined;

if (!board && !singleSession) {
  console.error('Usage: bun scripts/migrate-claude-session.ts --board [--dry-run]');
  console.error('       bun scripts/migrate-claude-session.ts --session <uuid> [--dry-run]');
  process.exit(1);
}

const CLAUDE_PROJECTS = join(homedir(), '.claude/projects');
const PI_SESSIONS = join(homedir(), '.pi/agent/sessions');

// ── Claude JSONL line shapes (loose) ────────────────────────────────────────

interface ClaudeLine {
  type?: string;
  isSidechain?: boolean;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
}

function findClaudeJsonl(sessionId: string): string | undefined {
  for (const dir of readdirSync(CLAUDE_PROJECTS)) {
    const p = join(CLAUDE_PROJECTS, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function epochMs(iso: string | undefined): number {
  return iso ? new Date(iso).getTime() : Date.now();
}

function textBlocksOf(content: unknown): Array<{ type: 'text'; text: string }> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: Array<{ type: 'text'; text: string }> = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text });
  }
  return out;
}

function mapStopReason(r: string | null | undefined): string {
  if (r === 'tool_use') return 'toolUse';
  if (r === 'max_tokens') return 'length';
  return 'stop';
}

// ── Migration ───────────────────────────────────────────────────────────────

function migrate(sessionId: string): { ok: boolean; error?: string; out?: string; entries?: number } {
  const src = findClaudeJsonl(sessionId);
  if (!src) return { ok: false, error: `no Claude JSONL found for ${sessionId}` };

  const lines: ClaudeLine[] = [];
  for (const raw of readFileSync(src, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw) as ClaudeLine); } catch { /* skip corrupt line */ }
  }

  const cwd = lines.find(l => typeof l.cwd === 'string' && l.cwd)?.cwd;
  if (!cwd) return { ok: false, error: 'no cwd found in session' };
  const headerTs = lines.find(l => l.timestamp)?.timestamp ?? new Date().toISOString();

  // tool_use id → tool name, for toolResult messages
  const toolNames = new Map<string, string>();
  for (const l of lines) {
    if (l.type !== 'assistant' || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message.content as Array<Record<string, unknown>>) {
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') toolNames.set(b.id, b.name);
    }
  }

  const entries: string[] = [];
  entries.push(JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: headerTs, cwd }));

  let parentId: string | null = null;
  let seq = 0;
  const push = (message: Record<string, unknown>, ts: string | undefined, idHint: string | undefined) => {
    const id = `${idHint ?? 'mig'}-${seq++}`;
    entries.push(JSON.stringify({ type: 'message', id, parentId, timestamp: ts ?? headerTs, message }));
    parentId = id;
  };

  // Merge consecutive assistant lines that share message.id (Claude splits blocks across lines)
  let pendingAssistant: { blocks: Array<Record<string, unknown>>; line: ClaudeLine } | null = null;
  const flushAssistant = () => {
    if (!pendingAssistant) return;
    const { blocks, line } = pendingAssistant;
    pendingAssistant = null;
    const content: Array<Record<string, unknown>> = [];
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking') content.push({ type: 'thinking', thinking: b.thinking ?? '', ...(typeof b.signature === 'string' ? { thinkingSignature: b.signature } : {}) });
      else if (b.type === 'tool_use') content.push({ type: 'toolCall', id: b.id, name: b.name, arguments: b.input ?? {} });
    }
    if (content.length === 0) return;
    const u = line.message?.usage ?? {};
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    push({
      role: 'assistant',
      content,
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: line.message?.model ?? 'unknown',
      usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: mapStopReason(line.message?.stop_reason),
      timestamp: epochMs(line.timestamp),
    }, line.timestamp, line.uuid);
  };

  for (const l of lines) {
    if (l.isSidechain) continue;
    if (l.type !== 'user' && l.type !== 'assistant') continue;
    const msg = l.message;
    if (!msg) continue;

    if (l.type === 'assistant') {
      if (pendingAssistant && pendingAssistant.line.message?.id === msg.id) {
        pendingAssistant.blocks.push(...(Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : []));
      } else {
        flushAssistant();
        pendingAssistant = { blocks: Array.isArray(msg.content) ? [...(msg.content as Array<Record<string, unknown>>)] : [], line: l };
      }
      continue;
    }

    flushAssistant();

    // user line: either real user text or tool_result carrier
    const content = msg.content;
    if (Array.isArray(content) && (content as Array<Record<string, unknown>>).some(b => b?.type === 'tool_result')) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.type !== 'tool_result') continue;
        const toolCallId = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
        const blocks = textBlocksOf(b.content);
        push({
          role: 'toolResult',
          toolCallId,
          toolName: toolNames.get(toolCallId) ?? 'unknown',
          content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }],
          isError: b.is_error === true,
          timestamp: epochMs(l.timestamp),
        }, l.timestamp, l.uuid);
      }
      continue;
    }

    const blocks = textBlocksOf(content);
    if (blocks.length === 0) continue;
    push({
      role: 'user',
      content: typeof content === 'string' ? content : blocks,
      timestamp: epochMs(l.timestamp),
    }, l.timestamp, l.uuid);
  }
  flushAssistant();

  if (entries.length <= 1) return { ok: false, error: 'no migratable messages' };

  const slug = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const dir = join(PI_SESSIONS, slug);
  const out = join(dir, `${headerTs.replace(/[:.]/g, '-')}_${sessionId}.jsonl`);

  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(out, entries.map(e => e + '\n').join(''));
  }
  return { ok: true, out, entries: entries.length - 1 };
}

// ── Main ────────────────────────────────────────────────────────────────────

const db = new Database(join(process.cwd(), 'data/orchestrel.db'), { readonly: true });
db.exec('PRAGMA query_only = 1');
const cards = singleSession
  ? db.prepare('SELECT id, title, session_id FROM cards WHERE session_id = ?').all(singleSession)
  : db.prepare("SELECT id, title, session_id FROM cards WHERE session_id IS NOT NULL AND session_id != '' AND column != 'archive'").all();
db.close();

if (cards.length === 0) {
  console.error('No matching cards found.');
  process.exit(1);
}

let failed = 0;
for (const card of cards as Array<{ id: number; title: string; session_id: string }>) {
  const r = migrate(card.session_id);
  if (r.ok) {
    console.log(`${dryRun ? '[DRY RUN] ' : ''}Card #${card.id} "${card.title}": ${r.entries} entries → ${r.out}`);
  } else {
    failed++;
    console.error(`Card #${card.id} "${card.title}": FAILED — ${r.error}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
