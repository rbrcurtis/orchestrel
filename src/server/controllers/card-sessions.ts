import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { messageBus, type MessageBus } from '../bus';
import { AppDataSource } from '../models/index';
import type { OrcdMessage } from '../../shared/orcd-protocol';
import type { OrcdClient } from '../orcd-client';
import { resolveWorkDir } from '../../shared/worktree';
import { prepareCompaction, applyCompaction, type PreparedCompaction } from '../../lib/session-compactor';
import { upsertMemories } from '../../lib/memory-upsert';
import { loadConfig } from '../../orcd/config';

// ── Session → Card routing map ───────────────────────────────────────────────

const sessionCardMap = new Map<string, number>();
const compactingCards = new Set<number>();
const pendingCompaction = new Set<number>();
const pendingSummaries = new Map<number, PreparedCompaction>();

/** Register a sessionId → cardId mapping so the global router can route messages. */
export function trackSession(cardId: number, sessionId: string): void {
  sessionCardMap.set(sessionId, cardId);
  console.log(`[orcd-router] tracking session ${sessionId.slice(0, 8)} → card ${cardId}`);
}

/** Remove a session from the routing map. */
export function untrackSession(sessionId: string): void {
  sessionCardMap.delete(sessionId);
}

// ── Global orcd message router ───────────────────────────────────────────────

/**
 * Register a single global onMessage handler on the OrcdClient.
 * Routes messages by looking up sessionId → cardId in the map.
 * Call once at startup — survives for the process lifetime.
 */
let routerInitialized = false;

export function initOrcdRouter(
  client: OrcdClient,
  bus: MessageBus = messageBus,
): void {
  if (routerInitialized) return;
  routerInitialized = true;
  const repo = () => AppDataSource.getRepository(Card);

  client.onMessage(async (msg: OrcdMessage) => {
    if (!('sessionId' in msg)) return;
    const cardId = sessionCardMap.get(msg.sessionId);
    if (cardId == null) return;

    if (msg.type === 'stream_event') {
      const sdkEvent = msg.event as Record<string, unknown>;
      bus.publish(`card:${cardId}:sdk`, sdkEvent);

      if (sdkEvent.type === 'system') {
        const sys = sdkEvent as { subtype?: string; session_id?: string };

        if (sys.subtype === 'init' && sys.session_id) {
          const card = await repo().findOneBy({ id: cardId });
          if (card && (!card.sessionId || card.sessionId.startsWith('msg_'))) {
            card.sessionId = sys.session_id;
            card.updatedAt = new Date().toISOString();
            await repo().save(card);
            console.log(`[oc:${cardId}] init: persisted sessionId=${sys.session_id}`);
          }
        }

        if (sys.subtype === 'compact_boundary') {
          const card = await repo().findOneBy({ id: cardId });
          if (card) {
            card.contextTokens = 0;
            card.updatedAt = new Date().toISOString();
            await repo().save(card);
            console.log(`[oc:${cardId}] compact_boundary: reset contextTokens to 0`);
          }
        }
      }
    }

    if (msg.type === 'result') {
      const result = msg.result as Record<string, unknown>;
      bus.publish(`card:${cardId}:sdk`, result);

      const card = await repo().findOneBy({ id: cardId });
      if (card) {
        card.turnsCompleted = (card.turnsCompleted ?? 0) + 1;
        card.updatedAt = new Date().toISOString();
        await repo().save(card);

        // Apply pre-computed compaction at turn end (instant — session is idle)
        const prepared = pendingSummaries.get(cardId);
        if (prepared) {
          pendingSummaries.delete(cardId);
          console.log(`[compact:${cardId}] applying pre-computed summary at turn end`);
          applyCompaction(prepared).then((result) => {
            console.log(
              `[compact:${cardId}] applied: ${result.messagesCovered}/${result.messagesBefore} messages, ` +
              `${result.summaryChars} chars summary`,
            );
          }).catch((err) => {
            console.error(`[compact:${cardId}] apply failed:`, err);
          });
        }

        // Kick off background prepare for next compaction cycle
        if (pendingCompaction.has(cardId) && !compactingCards.has(cardId)) {
          pendingCompaction.delete(cardId);
          compactingCards.add(cardId);
          triggerCompaction(cardId, card).catch((err) => {
            console.error(`[compact:${cardId}] failed:`, err);
          }).finally(() => {
            compactingCards.delete(cardId);
          });
        }
      }
    }

    if (msg.type === 'context_usage') {
      const card = await repo().findOneBy({ id: cardId });
      if (card) {
        card.contextTokens = msg.contextTokens;
        card.contextWindow = msg.contextWindow;
        card.updatedAt = new Date().toISOString();
        await repo().save(card);

        // Mark for compaction — actual compaction deferred to turn end (result event)
        // to avoid racing with active JSONL writes
        if (
          card.summarizeThreshold > 0 &&
          card.contextWindow > 0 &&
          !compactingCards.has(cardId) &&
          !pendingCompaction.has(cardId) &&
          card.contextTokens / card.contextWindow >= card.summarizeThreshold
        ) {
          pendingCompaction.add(cardId);
          console.log(`[compact:${cardId}] marked for compaction at turn end (${((card.contextTokens / card.contextWindow) * 100).toFixed(0)}%)`);
        }
      }
      bus.publish(`card:${cardId}:context`, {
        contextTokens: msg.contextTokens,
        contextWindow: msg.contextWindow,
      });
    }

    if (msg.type === 'error') {
      bus.publish(`card:${cardId}:sdk`, {
        type: 'error',
        message: msg.error,
        timestamp: Date.now(),
      });
    }

    if (msg.type === 'session_exit') {
      await handleSessionExit(cardId, bus);
      untrackSession(msg.sessionId);
    }
  });

  console.log('[orcd-router] global handler registered');
}

// ── Session exit ─────────────────────────────────────────────────────────────

async function handleSessionExit(
  cardId: number,
  bus: MessageBus = messageBus,
): Promise<void> {
  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });

  if (card && card.column === 'running') {
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
  }

  bus.publish(`card:${cardId}:exit`, {
    sessionId: card?.sessionId,
    status: 'completed',
  });
}

// ── Reconciliation ──────────────────────────────────────────────────────────

/**
 * Check all running cards against orcd's active sessions.
 * Cards whose sessions are no longer in orcd get moved to review.
 * Called at startup and on OrcdClient reconnect (orcd restart).
 */
export async function reconcileRunningCards(
  client: OrcdClient,
  bus: MessageBus = messageBus,
): Promise<void> {
  const r = AppDataSource.getRepository(Card);
  const runningCards = await r.find({ where: { column: 'running' } });
  if (runningCards.length === 0) return;

  const activeList = await client.list();
  const activeIds = new Set(activeList.sessions.map((s) => s.id));

  for (const card of runningCards) {
    if (card.sessionId && activeIds.has(card.sessionId)) {
      trackSession(card.id, card.sessionId);
      client.markActive(card.sessionId);
      console.log(`[reconcile] card ${card.id} still active in orcd, tracking`);
    } else {
      card.column = 'review';
      card.updatedAt = new Date().toISOString();
      await r.save(card);
      if (card.sessionId) untrackSession(card.sessionId);
      bus.publish(`card:${card.id}:exit`, {
        sessionId: card.sessionId,
        status: 'stopped',
      });
      console.log(
        `[reconcile] card ${card.id} moved to review (${card.sessionId ? 'session not in orcd' : 'no sessionId'})`,
      );
    }
  }
}

// ── Board event listeners ────────────────────────────────────────────────────

export function registerAutoStart(bus: MessageBus = messageBus): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;

    // Card entered running
    if (newColumn === 'running' && oldColumn !== 'running') {
      const initState = await import('../init-state');
      const client = initState.getOrcdClient();
      if (!client) return;

      const fullCard = await repo().findOneBy({ id: card.id });
      if (!fullCard) return;

      // Check if already active in orcd
      if (fullCard.sessionId && client.isActive(fullCard.sessionId)) return;

      console.log(
        `[oc:auto-start] card #${card.id} entered running ` +
          `(worktree=${!!card.worktreeBranch}, project=${card.projectId})`,
      );
      const { ensureWorktree } = await import('../sessions/worktree');
      const cwd = await ensureWorktree(fullCard);
      const prompt = fullCard.sessionId ? '' : fullCard.description ?? '';

      const sessionId = await client.create({
        prompt,
        cwd,
        provider: fullCard.provider,
        model: fullCard.model,
        sessionId: fullCard.sessionId ?? undefined,
        contextWindow: fullCard.contextWindow,
      });

      fullCard.sessionId = sessionId;
      fullCard.updatedAt = new Date().toISOString();
      await repo().save(fullCard);

      trackSession(fullCard.id, sessionId);
    }

    // Card left running: cancel session
    if (oldColumn === 'running' && newColumn !== 'running') {
      const initState = await import('../init-state');
      const client = initState.getOrcdClient();
      if (card.sessionId) {
        client?.cancel(card.sessionId);
      }
    }
  });
}

export function registerWorktreeCleanup(bus: MessageBus = messageBus): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;
    if (newColumn !== 'archive' || oldColumn === 'archive') return;

    const c = card as Card;
    if (!c.worktreeBranch || !c.projectId) return;

    try {
      const { Project } = await import('../models/Project');
      const proj = await Project.findOneBy({ id: c.projectId });
      if (!proj) return;

      const { resolveWorkDir } = await import('../../shared/worktree');
      const wtPath = resolveWorkDir(c.worktreeBranch, proj.path);
      const { removeWorktree, worktreeExists } = await import('../worktree');
      if (worktreeExists(wtPath)) {
        removeWorktree(proj.path, wtPath);
        console.log(`[oc:worktree] removed ${wtPath}`);
      }
    } catch (err) {
      console.error(`[oc:worktree] cleanup failed for card ${c.id}:`, err);
    }
  });
}

/**
 * Run memory upsert for a card — extract facts from conversation and store in memory API.
 * Returns true if upsert ran, false if skipped (not configured / no session).
 */
async function runMemoryUpsert(cardId: number, card: Card): Promise<boolean> {
  if (!card.sessionId || !card.projectId) return false;

  const proj = await Project.findOneBy({ id: card.projectId });
  if (!proj) return false;

  const config = await loadConfig();
  const memBaseUrl = proj.memoryBaseUrl ?? config.memoryUpsert?.baseUrl;
  const memApiKey = proj.memoryApiKey ?? config.memoryUpsert?.apiKey;
  const memEnabled = config.memoryUpsert?.enabled !== false && !!memBaseUrl && !!memApiKey;

  if (!memEnabled) return false;

  const cwd = resolveWorkDir(card.worktreeBranch ?? null, proj.path);
  console.log(`[memory-upsert:${cardId}] extracting memories (server: ${memBaseUrl})`);

  const upsertResult = await upsertMemories({
    sessionId: card.sessionId,
    projectPath: cwd,
    projectName: proj.name,
    model: card.model,
    memoryBaseUrl: memBaseUrl!,
    memoryApiKey: memApiKey!,
  });

  console.log(
    `[memory-upsert:${cardId}] done: ${upsertResult.factsStored}/${upsertResult.factsExtracted} facts stored, ${upsertResult.durationMs}ms`,
  );
  return true;
}

async function triggerCompaction(cardId: number, card: Card): Promise<void> {
  if (!card.sessionId || !card.projectId) return;

  const proj = await Project.findOneBy({ id: card.projectId });
  if (!proj) return;

  // Step 1: Memory upsert — extract facts from ALL messages since last boundary
  try {
    await runMemoryUpsert(cardId, card);
  } catch (err) {
    console.error(`[memory-upsert:${cardId}] failed (continuing to compaction):`, err);
  }

  // Step 2: Prepare compaction summary in background (no file writes)
  const cwd = resolveWorkDir(card.worktreeBranch ?? null, proj.path);
  console.log(`[compact:${cardId}] preparing summary in background (${card.contextTokens}/${card.contextWindow} = ${((card.contextTokens / card.contextWindow) * 100).toFixed(0)}%)`);

  const prepared = await prepareCompaction({
    sessionId: card.sessionId,
    projectPath: cwd,
    model: card.model,
  });

  // Store the prepared summary — it will be applied at the next turn end
  pendingSummaries.set(cardId, prepared);
  console.log(
    `[compact:${cardId}] summary ready (${prepared.messagesCovered}/${prepared.messagesBefore} messages, ` +
    `${prepared.summaryChars} chars, ${prepared.prepareDurationMs}ms) — waiting for turn end to apply`
  );
}

export function registerMemoryUpsertOnComplete(bus: MessageBus = messageBus): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;

    // Only on first transition to done/archive — skip done→archive (already upserted)
    const isTerminal = newColumn === 'done' || newColumn === 'archive';
    const wasTerminal = oldColumn === 'done' || oldColumn === 'archive';
    if (!isTerminal || wasTerminal) return;

    if (!card.sessionId || !card.projectId) return;

    runMemoryUpsert(card.id, card).catch((err) => {
      console.error(`[memory-upsert:${card.id}] on-complete failed:`, err);
    });
  });
}

function repo() {
  return AppDataSource.getRepository(Card);
}
