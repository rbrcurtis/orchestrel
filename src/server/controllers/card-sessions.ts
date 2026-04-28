import { Card } from '../models/Card';
import { messageBus, type MessageBus } from '../bus';
import { AppDataSource } from '../models/index';
import type { OrcdMessage } from '../../shared/orcd-protocol';
import type { OrcdClient } from '../orcd-client';

// ── Session → Card routing map ───────────────────────────────────────────────

const sessionCardMap = new Map<string, number>();

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

let routerInitialized = false;

export function initOrcdRouter(
  client: OrcdClient,
  bus: MessageBus = messageBus,
): void {
  if (routerInitialized) {
    console.log(`[orcd-router] initOrcdRouter: already initialized, skipping`);
    return;
  }
  routerInitialized = true;
  const repo = () => AppDataSource.getRepository(Card);

  client.onMessage(async (msg: OrcdMessage) => {
    if (!('sessionId' in msg)) {
      console.log(`[orcd-router] dropping message with no sessionId: type=${msg.type}`);
      return;
    }
    let cardId = sessionCardMap.get(msg.sessionId);
    if (cardId == null && msg.type === 'session_exit') {
      const card = await repo().findOneBy({ sessionId: msg.sessionId });
      if (card) {
        cardId = card.id;
        trackSession(cardId, msg.sessionId);
      }
    }
    if (cardId == null) {
      console.log(`[orcd-router] no card for session ${msg.sessionId.slice(0, 8)}, dropping type=${msg.type}`);
      return;
    }

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
            card.contextTokens = 1;
            card.updatedAt = new Date().toISOString();
            await repo().save(card);
            console.log(`[oc:${cardId}] compact_boundary: reset contextTokens to 1`);
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

    if (msg.type === 'session_id_update') {
      const card = await repo().findOneBy({ id: cardId });
      if (card) {
        card.sessionId = msg.newSessionId;
        card.updatedAt = new Date().toISOString();
        await repo().save(card);
      }
      trackSession(cardId, msg.newSessionId);
      console.log(`[oc:${cardId}] session forked: ${msg.sessionId.slice(0,8)} → ${msg.newSessionId.slice(0,8)}`);
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

export async function reconcileRunningCards(
  client: OrcdClient,
  bus: MessageBus = messageBus,
): Promise<void> {
  const r = AppDataSource.getRepository(Card);

  // Query orcd's live session list first. This is the source of truth —
  // client.isActive() reads from in-memory cache which gets cleared on
  // orchestrel restart / orcd disconnect.
  const activeList = await client.list();
  const runningSessions = activeList.sessions.filter((s) => s.state === 'running');
  const activeIds = new Set(runningSessions.map((s) => s.id));

  // Re-seed in-memory isActive tracking + router mapping for every orcd
  // session that maps to a known card. This ensures client.isActive() tells
  // the truth after an orchestrel restart, so auto-start + agent:send
  // correctly detect whether a session exists and route through create
  // (which passes summarizeThreshold + attaches lifecycle hooks).
  const allCards = await r.find();
  const cardBySession = new Map<string, Card>();
  for (const c of allCards) {
    if (c.sessionId) cardBySession.set(c.sessionId, c);
  }

  for (const sess of runningSessions) {
    const card = cardBySession.get(sess.id);
    if (!card) continue;
    client.markActive(sess.id);
    trackSession(card.id, sess.id);
    console.log(`[reconcile] re-seeded tracking for card ${card.id} session ${sess.id.slice(0, 8)}`);
  }

  // Move running-column cards whose session is no longer alive in orcd back
  // to review.
  const runningCards = allCards.filter((c) => c.column === 'running');
  if (runningCards.length === 0) {
    console.log(`[reconcile] no running cards to reconcile`);
    return;
  }

  for (const card of runningCards) {
    if (card.sessionId && activeIds.has(card.sessionId)) {
      console.log(`[reconcile] card ${card.id} still active in orcd`);
      continue;
    }
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

// ── Board event listeners ────────────────────────────────────────────────────

export function registerAutoStart(bus: MessageBus = messageBus): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) {
      console.log(`[oc:auto-start] board:changed with null card, skipping`);
      return;
    }

    // Card entered running
    if (newColumn === 'running' && oldColumn !== 'running') {
      const initState = await import('../init-state');
      const client = initState.getOrcdClient();
      if (!client) {
        console.log(`[oc:auto-start] card #${card.id} entered running but no orcd client, skipping`);
        return;
      }

      const fullCard = await repo().findOneBy({ id: card.id });
      if (!fullCard) {
        console.log(`[oc:auto-start] card #${card.id} vanished before auto-start`);
        return;
      }

      // Check if already active in orcd
      if (fullCard.sessionId && client.isActive(fullCard.sessionId)) {
        console.log(`[oc:auto-start] card #${card.id} session ${fullCard.sessionId.slice(0, 8)} already active`);
        return;
      }

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
        summarizeThreshold: fullCard.summarizeThreshold,
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
    if (!card) {
      console.log(`[oc:worktree] board:changed with null card, skipping cleanup`);
      return;
    }
    if (newColumn !== 'archive' || oldColumn === 'archive') {
      console.log(`[oc:worktree] card ${card.id} column ${oldColumn} → ${newColumn}: not a fresh archive transition, skipping cleanup`);
      return;
    }

    const c = card as Card;
    if (!c.worktreeBranch || !c.projectId) {
      console.log(`[oc:worktree] card ${c.id} has no worktree/project, skipping cleanup`);
      return;
    }

    try {
      const { Project } = await import('../models/Project');
      const proj = await Project.findOneBy({ id: c.projectId });
      if (!proj) {
        console.log(`[oc:worktree] card ${c.id} project ${c.projectId} not found, skipping cleanup`);
        return;
      }

      const { resolveWorkDir } = await import('../../shared/worktree');
      const wtPath = resolveWorkDir(c.worktreeBranch, proj.path);
      const { removeWorktree, worktreeExists } = await import('../worktree');
      if (worktreeExists(wtPath)) {
        removeWorktree(proj.path, wtPath);
        console.log(`[oc:worktree] removed ${wtPath}`);
      }
    } catch (err) {
      console.error(`[oc:worktree] cleanup failed for card ${c.id}:`, err);
      // handled: cleanup failure is non-fatal
    }
  });
}

export function registerMemoryUpsertOnArchive(bus: MessageBus = messageBus): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) {
      console.log(`[oc:memory] board:changed with null card, skipping upsert`);
      return;
    }

    // Only on first transition to done/archive — skip done→archive (already upserted by orcd on exit)
    const isTerminal = newColumn === 'done' || newColumn === 'archive';
    const wasTerminal = oldColumn === 'done' || oldColumn === 'archive';
    if (!isTerminal || wasTerminal) {
      console.log(`[oc:memory] card ${card.id} column ${oldColumn} → ${newColumn}: not a fresh terminal transition, skipping upsert`);
      return;
    }
    if (!card.sessionId) {
      console.log(`[oc:memory] card ${card.id} entering ${newColumn} with no sessionId, skipping upsert`);
      return;
    }

    const initState = await import('../init-state');
    const client = initState.getOrcdClient();
    if (!client) {
      console.log(`[oc:memory] card ${card.id} (session ${card.sessionId.slice(0, 8)}): no orcd client, skipping upsert`);
      return;
    }

    console.log(`[oc:memory] requesting upsert for card ${card.id} (${oldColumn} → ${newColumn})`);
    client.memoryUpsert(card.sessionId);
  });
}

function repo() {
  return AppDataSource.getRepository(Card);
}
