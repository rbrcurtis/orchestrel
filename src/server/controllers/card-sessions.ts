import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { messageBus, type MessageBus } from '../bus';
import { AppDataSource } from '../models/index';
import type { OrcdMessage } from '../../shared/orcd-protocol';
import type { OrcdClient } from '../orcd-client';
import { resolveWorkDir } from '../../shared/worktree';
import { compactSession } from '../../lib/session-compactor';
import { upsertMemories } from '../../lib/memory-upsert';
import { loadConfig } from '../../orcd/config';

// ── Session → Card routing map ───────────────────────────────────────────────

const sessionCardMap = new Map<string, number>();
const compactingCards = new Set<number>();

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
      }
    }

    if (msg.type === 'context_usage') {
      const card = await repo().findOneBy({ id: cardId });
      if (card) {
        card.contextTokens = msg.contextTokens;
        card.contextWindow = msg.contextWindow;
        card.updatedAt = new Date().toISOString();
        await repo().save(card);

        // Check if background compaction should trigger
        if (
          card.summarizeThreshold > 0 &&
          card.contextWindow > 0 &&
          !compactingCards.has(cardId) &&
          card.contextTokens / card.contextWindow >= card.summarizeThreshold
        ) {
          compactingCards.add(cardId);
          triggerCompaction(cardId, card).catch((err) => {
            console.error(`[compact:${cardId}] failed:`, err);
          }).finally(() => {
            compactingCards.delete(cardId);
          });
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

async function triggerCompaction(cardId: number, card: Card): Promise<void> {
  if (!card.sessionId || !card.projectId) return;

  const proj = await Project.findOneBy({ id: card.projectId });
  if (!proj) return;

  const cwd = resolveWorkDir(card.worktreeBranch ?? null, proj.path);

  // Step 1: Memory upsert — extract facts from ALL messages since last boundary
  // Per-project memory config overrides global; skip if neither is configured
  try {
    const config = await loadConfig();
    const orProvider = config.providers.openrouter;
    const memBaseUrl = proj.memoryBaseUrl ?? config.memoryUpsert?.baseUrl;
    const memApiKey = proj.memoryApiKey ?? config.memoryUpsert?.apiKey;
    const memEnabled = config.memoryUpsert?.enabled !== false && !!memBaseUrl && !!memApiKey && !!orProvider;

    if (memEnabled) {
      console.log(`[memory-upsert:${cardId}] extracting memories before compaction (server: ${memBaseUrl})`);
      const upsertResult = await upsertMemories({
        sessionId: card.sessionId,
        projectPath: cwd,
        projectName: proj.name,
        openRouterBaseUrl: orProvider.baseUrl,
        openRouterApiKey: orProvider.apiKey,
        memoryBaseUrl: memBaseUrl!,
        memoryApiKey: memApiKey!,
        model: config.memoryUpsert?.model,
      });
      console.log(
        `[memory-upsert:${cardId}] done: ${upsertResult.factsStored}/${upsertResult.factsExtracted} facts stored, ${upsertResult.durationMs}ms`,
      );
    }
  } catch (err) {
    console.error(`[memory-upsert:${cardId}] failed (continuing to compaction):`, err);
  }

  // Step 2: Compact — summarize oldest 50% using the card's own model via Agent SDK
  console.log(`[compact:${cardId}] triggering background compaction (${card.contextTokens}/${card.contextWindow} = ${((card.contextTokens / card.contextWindow) * 100).toFixed(0)}%)`);

  const result = await compactSession({
    sessionId: card.sessionId,
    projectPath: cwd,
    model: card.model,
  });

  console.log(
    `[compact:${cardId}] done: ${result.messagesCovered}/${result.messagesBefore} messages, ` +
    `${result.summaryChars} chars summary, ${result.durationMs}ms`
  );
}

function repo() {
  return AppDataSource.getRepository(Card);
}
