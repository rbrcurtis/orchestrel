/* Preference maintainer: separate from the knowledge memory maintainer. Where
 * the knowledge maintainer STAGES knowledge ops as JSON for review, this one
 * WRITES to one canonical preference memory per user (title `Preferences:
 * <email>`) in the shared preference project. It runs the same tool loop as the
 * knowledge consolidator, but with the preference prompt and the node's default
 * provider/model/thinking level from orcd.yaml.
 *
 * Every run also dumps a local before/after trail under TRAIL_DIR so a human can
 * review what changed without reading the memory server. Errors in one user
 * never abort the run; the per-file watermark advances regardless so a
 * consistently-failing session is not retried forever (same as the knowledge
 * maintainer). */
import type { Api, Model, ThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type Database from 'better-sqlite3';
import type { MemoryPreferencesConfig, OrchestrelConfig } from '../../shared/config';
import { buildModel, consolidate } from '../memory-maintainer/consolidate';
import { finishRun, getDb, insertRun, recentActiveRun, upsertWatermark } from '../memory-maintainer/db';
import { buildExcerpt, listHumanAuthors } from '../memory-maintainer/excerpt';
import { updateMemory, type MemoryHit, type MemoryServer } from '../memory-maintainer/memory-api';
import { sweepSessions, type SessionFile } from '../memory-maintainer/sweep';
import { sendTelegramAlert } from '../memory-maintainer/telegram';
import { findCanonical } from './canonical';
import { buildPreferencePrompt, canonicalTitle } from './prompt';
import { TRAIL_DIR, writeTrail } from './trail';

const VALID_THINKING = new Set<ThinkingLevel>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export interface PreferenceUserSummary {
  userId: number;
  email: string;
  ops: number;
  /** Set when the budget enforcement changed the canonical body. */
  budget?: string;
  error?: string;
  trailFile?: string;
}

export interface PreferenceSummary {
  runId: number;
  users: PreferenceUserSummary[];
  durationMs: number;
  skipped?: boolean;
}

export async function runPreferences(cfg: OrchestrelConfig): Promise<PreferenceSummary | null> {
  const memory = cfg.memory;
  if (!memory?.preferences) return null;

  const db = getDb();
  const runId = insertRun(db, 'preference', new Date().toISOString());
  if (recentActiveRun(db, 'preference', runId)) {
    finishRun(db, runId, 'skipped', JSON.stringify({ reason: 'another preference run in progress' }));
    return { runId, users: [], durationMs: 0, skipped: true };
  }

  const started = Date.now();
  const prefCfg = memory.preferences;
  const server = resolvePreferenceServer(db, prefCfg);
  const stalenessDays = prefCfg.stalenessDays ?? 30;
  const maxTokens = prefCfg.maxTokens ?? 2000;
  const today = new Date().toISOString().slice(0, 10);

  try {
    // Preference sweep ignores project routing: preferences are cross-project,
    // so a session in a project without knowledge memory still counts.
    const sweep = sweepSessions(memory, { requireProject: false, watermarkTable: 'preference_maintainer_watermark' });
    if (sweep.files.length === 0) {
      const summary: PreferenceSummary = { runId, users: [], durationMs: Date.now() - started };
      finishRun(db, runId, 'done', JSON.stringify(summary));
      return summary;
    }

    // Group each swept file under every human author who typed in it.
    const byUser = new Map<number, { email: string; files: SessionFile[] }>();
    for (const f of sweep.files) {
      for (const a of listHumanAuthors(f.path)) {
        const entry = byUser.get(a.userId) ?? { email: a.email, files: [] };
        entry.files.push(f);
        byUser.set(a.userId, entry);
      }
    }

    const users: PreferenceUserSummary[] = [];
    if (byUser.size > 0) {
      const { runtime, model } = await buildModel(cfg, cfg.defaultProvider, cfg.defaultModel);
      const reasoning = toReasoning(cfg.defaultThinkingLevel);
      for (const [userId, { email, files }] of byUser) {
        try {
          const text = combineHumanExcerpts(files, userId, memory.excerptTokens);
          if (!text.trim()) {
            users.push({ userId, email, ops: 0 });
            continue;
          }
          const title = canonicalTitle(email);
          const before = await findCanonical(server, title);
          const ops = await consolidate({
            excerpt: {
              sessionId: `user-${userId}`,
              cwd: '',
              startedAt: today,
              text,
              tokenEstimate: Math.ceil(text.length / 4),
            },
            server,
            runtime,
            model,
            maxTurns: memory.maxTurns,
            mode: 'write',
            systemPrompt: buildPreferencePrompt({ email, title, today, stalenessDays, maxTokens, existing: before }),
            ...(reasoning ? { reasoning } : {}),
          });
          let after = await findCanonical(server, title);
          let budget: string | undefined;
          if (after && estTokens(after.text) > maxTokens) {
            const enforced = await enforceBudget(server, runtime, model, reasoning, after, maxTokens);
            if (enforced.note) {
              after = enforced.hit;
              budget = enforced.note;
            }
          }
          const trailFile = writeTrail({
            userId,
            email,
            at: new Date().toISOString(),
            before,
            after,
            ops,
            ...(budget ? { budget } : {}),
          });
          users.push({ userId, email, ops: ops.length, trailFile, ...(budget ? { budget } : {}) });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[preference-maintainer] user ${userId} (${email}) failed:`, message);
          users.push({ userId, email, ops: 0, error: message });
        }
      }
    }

    // Advance every swept file's watermark regardless of per-user errors, so a
    // failing session is not retried forever (matches the knowledge maintainer).
    for (const f of sweep.files) {
      upsertWatermark(db, f.path, f.mtimeMs, f.size, 'preference_maintainer_watermark');
    }

    const summary: PreferenceSummary = { runId, users, durationMs: Date.now() - started };
    finishRun(db, runId, 'done', JSON.stringify(summary));
    if (memory.telegram) {
      try {
        await sendTelegramAlert(memory.telegram.botToken, memory.telegram.chatId, buildPreferenceAlert(summary));
      } catch (err) {
        console.error('[preference-maintainer] telegram alert failed:', err);
      }
    }
    return summary;
  } catch (err) {
    finishRun(db, runId, 'failed', JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    throw err;
  }
}

/**
 * Resolve the canonical preference memory server. Project rows still carry the
 * legacy per-project memory url/key, while the service env does not carry
 * TRACKABLE_MEMORY_API_KEY, so a row with a key wins over the orcd.yaml
 * default. The project slug stays the preferences slug from config.
 */
export function resolvePreferenceServer(db: Database.Database, prefs: MemoryPreferencesConfig): MemoryServer {
  const row = db
    .prepare(
      `SELECT memory_base_url, memory_api_key FROM projects
       WHERE memory_api_key IS NOT NULL AND memory_api_key <> '' ORDER BY id LIMIT 1`,
    )
    .get() as { memory_base_url: string | null; memory_api_key: string } | undefined;
  if (row?.memory_api_key) {
    return { apiUrl: row.memory_base_url || prefs.apiUrl, apiKey: row.memory_api_key, project: prefs.project };
  }
  return { apiUrl: prefs.apiUrl, apiKey: prefs.apiKey, project: prefs.project };
}

/** Rough token estimate (4 chars/token), good enough for budgeting. */
export const estTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Deterministic budget floor: keep the most recently seen lines until the body
 * fits the token budget, preserving the original line order. When even a
 * single line exceeds the budget, that most-recent line is kept alone.
 */
export function pruneToBudget(text: string, maxTokens: number): string {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return '';
  const seen = (l: string) => l.match(/\(seen: (\d{4}-\d{2}-\d{2})\)/)?.[1] ?? '';
  const order = lines.map((l, i) => ({ l, i, s: seen(l) })).sort((a, b) => b.s.localeCompare(a.s) || a.i - b.i);
  let total = 0;
  const keep = new Set<number>();
  for (const { l, i } of order) {
    const cost = estTokens(l) + (total > 0 ? 1 : 0);
    if (total + cost > maxTokens) continue;
    total += cost;
    keep.add(i);
  }
  if (keep.size === 0) keep.add(order[0].i);
  return lines.filter((_, i) => keep.has(i)).join('\n');
}

/** Single no-tools model call: rewrite the body so it fits the budget. */
async function condenseBody(
  runtime: ModelRuntime,
  model: Model<Api>,
  reasoning: ThinkingLevel | undefined,
  text: string,
  maxTokens: number,
): Promise<string | null> {
  const msg = await runtime.completeSimple(
    model,
    {
      systemPrompt: `Rewrite the preference memory below so the entire body fits under ${maxTokens} tokens (about ${maxTokens * 4} characters). Merge related lines into denser ones, drop the least salient and least recent, keep the most important standing preferences. Keep the exact format: one preference per line, each line self-contained, each ending with " (seen: YYYY-MM-DD)". Output ONLY the rewritten body — no preamble, no markdown fences.`,
      messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }],
      tools: [],
    },
    reasoning ? { reasoning } : undefined,
  );
  const out = msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!out) return null;
  return (
    out
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim() || null
  );
}

/**
 * Enforce the token budget on the canonical body: model condensation first,
 * deterministic line-pruning as the floor. Returns the final hit plus a note
 * when the body changed.
 */
async function enforceBudget(
  server: MemoryServer,
  runtime: ModelRuntime,
  model: Model<Api>,
  reasoning: ThinkingLevel | undefined,
  hit: MemoryHit,
  maxTokens: number,
): Promise<{ hit: MemoryHit; note?: string }> {
  let candidate: string | null = null;
  try {
    candidate = await condenseBody(runtime, model, reasoning, hit.text, maxTokens);
    if (!candidate || estTokens(candidate) > maxTokens || estTokens(candidate) >= estTokens(hit.text)) candidate = null;
  } catch (err) {
    console.error('[preference-maintainer] condense failed, falling back to prune:', err);
  }
  if (candidate) {
    await updateMemory(server, { id: hit.id, text: candidate });
    return { hit: { ...hit, text: candidate }, note: `budget: condensed to ${estTokens(candidate)} tokens` };
  }
  const pruned = pruneToBudget(hit.text, maxTokens);
  if (pruned !== hit.text && estTokens(pruned) <= maxTokens) {
    await updateMemory(server, { id: hit.id, text: pruned });
    return { hit: { ...hit, text: pruned }, note: `budget: pruned to ${estTokens(pruned)} tokens` };
  }
  if (estTokens(hit.text) > maxTokens) {
    console.warn(`[preference-maintainer] budget not met for ${hit.id}; a single line exceeds the limit`);
  }
  return { hit };
}

/** Keep the newest sessions that fit the excerpt budget (sweep sorts newest first). */
function combineHumanExcerpts(files: SessionFile[], userId: number, maxTokens: number): string {
  const budget = maxTokens * 4;
  const parts: string[] = [];
  let total = 0;
  for (const f of files) {
    const ex = buildExcerpt(f.path, maxTokens, { humanOnly: true, userId });
    if (!ex.text.trim()) continue;
    const block = `--- session ${f.sessionId} ---\n${ex.text}`;
    if (total + block.length > budget) break;
    parts.push(block);
    total += block.length + 2;
  }
  return parts.join('\n\n');
}

function toReasoning(level: string | undefined): ThinkingLevel | undefined {
  return level && VALID_THINKING.has(level as ThinkingLevel) ? (level as ThinkingLevel) : undefined;
}

export function buildPreferenceAlert(summary: PreferenceSummary): string {
  if (summary.skipped) return 'Preference maintainer: run skipped — another preference run already in progress.';
  const lines = summary.users.map(
    (u) =>
      `${u.email} (user ${u.userId}): ${u.ops} op(s)${u.budget ? ` — ${u.budget}` : ''}${u.error ? ` — ERROR: ${u.error}` : ''}`,
  );
  return [
    `Preference maintainer (${new Date().toISOString().slice(0, 10)})`,
    ...(lines.length ? lines : ['no users with new human-authored prompts']),
    `Review trail: ${TRAIL_DIR}`,
    `Duration: ${summary.durationMs}ms`,
  ].join('\n');
}
