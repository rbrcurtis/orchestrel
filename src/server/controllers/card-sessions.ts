import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { messageBus, type MessageBus } from '../bus';
import { AppDataSource } from '../models/index';
import { processQueue } from '../services/queue-gate';
import type { OrcdMessage } from '../../shared/orcd-protocol';

/**
 * Register per-card session event handlers.
 * Listens to OrcdClient messages for the given sessionId and:
 * - Forwards SDK events to card's messageBus topic (for Socket.IO bridge)
 * - Persists session counters to DB on result
 * - Moves card to review on session exit
 */
export function registerCardSession(cardId: number, sessionId: string): void {
  const repo = AppDataSource.getRepository(Card);
  let registered = true;

  const handler = async (msg: OrcdMessage) => {
    if (!registered) return;

    // Only handle events for our session
    if (!('sessionId' in msg) || msg.sessionId !== sessionId) return;

    if (msg.type === 'stream_event') {
      const sdkEvent = msg.event as Record<string, unknown>;

      // Forward to messageBus for Socket.IO bridge
      messageBus.publish(`card:${cardId}:sdk`, sdkEvent);

      // Handle system messages
      if (sdkEvent.type === 'system') {
        const sys = sdkEvent as { subtype?: string; session_id?: string };

        // Session init: persist sessionId
        if (sys.subtype === 'init' && sys.session_id) {
          const card = await repo.findOneBy({ id: cardId });
          if (card && (!card.sessionId || card.sessionId.startsWith('msg_'))) {
            card.sessionId = sys.session_id;
            card.updatedAt = new Date().toISOString();
            await repo.save(card);
            console.log(`[oc:${cardId}] init: persisted sessionId=${sys.session_id}`);
          }
        }

        // Compact boundary: reset context tokens
        if (sys.subtype === 'compact_boundary') {
          const card = await repo.findOneBy({ id: cardId });
          if (card) {
            card.contextTokens = 0;
            card.updatedAt = new Date().toISOString();
            await repo.save(card);
            console.log(`[oc:${cardId}] compact_boundary: reset contextTokens to 0`);
          }
        }
      }
    }

    if (msg.type === 'result') {
      const result = msg.result as Record<string, unknown>;
      messageBus.publish(`card:${cardId}:sdk`, result);

      // Persist turn count (result = one turn done, but session may still be alive for background tasks)
      const card = await repo.findOneBy({ id: cardId });
      if (card) {
        card.turnsCompleted = (card.turnsCompleted ?? 0) + 1;
        card.updatedAt = new Date().toISOString();
        await repo.save(card);
      }
    }

    if (msg.type === 'error') {
      messageBus.publish(`card:${cardId}:sdk`, {
        type: 'error',
        message: msg.error,
        timestamp: Date.now(),
      });
    }

    // Session actually exited (orcd iterator closed) — now move card to review
    if (msg.type === 'session_exit') {
      await handleSessionExit(cardId);
      unregister();
    }
  };

  const unregister = async () => {
    registered = false;
    const initState = await import('../init-state');
    const client = initState.getOrcdClient();
    client?.offMessage(handler);
  };

  // Register handler on OrcdClient
  import('../init-state').then((initState) => {
    const client = initState.getOrcdClient();
    client?.onMessage(handler);
  });
}

async function handleSessionExit(cardId: number): Promise<void> {
  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });

  if (card && card.column === 'running') {
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
  }

  // Process queue for non-worktree cards
  const freshCard = await repo.findOneBy({ id: cardId });
  if (freshCard && !freshCard.worktreeBranch && freshCard.projectId) {
    processQueue(freshCard.projectId).catch((err) => {
      console.error(`[oc:${cardId}] processQueue failed on exit:`, err);
    });
  }

  messageBus.publish(`card:${cardId}:exit`, {
    sessionId: card?.sessionId,
    status: 'completed',
  });
}

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

      // Non-worktree cards on git repos: delegate to queue processing
      if (!fullCard.worktreeBranch && fullCard.projectId) {
        const proj = await Project.findOneBy({ id: fullCard.projectId });
        if (proj?.isGitRepo) {
          console.log(
            `[oc:auto-start] card #${card.id} entered running ` +
              `(non-worktree, project=${card.projectId}, qP=${card.queuePosition})`,
          );
          processQueue(fullCard.projectId).catch((err) => {
            console.error(`[oc:auto-start] processQueue failed for card #${card.id}:`, err);
          });
          return;
        }
      }

      // Direct start (worktree or no project)
      console.log(
        `[oc:auto-start] card #${card.id} entered running ` +
          `(worktree=${!!card.worktreeBranch}, project=${card.projectId})`,
      );
      const { ensureWorktree } = await import('../sessions/worktree');
      const cwd = await ensureWorktree(fullCard);
      const prompt = fullCard.pendingPrompt ?? (fullCard.sessionId ? '' : fullCard.description ?? '');
      fullCard.pendingPrompt = null;
      fullCard.pendingFiles = null;
      await repo().save(fullCard);

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

      registerCardSession(fullCard.id, sessionId);
    }

    // Card left running: cancel session
    if (oldColumn === 'running' && newColumn !== 'running') {
      const initState = await import('../init-state');
      const client = initState.getOrcdClient();
      if (card.sessionId) {
        client?.cancel(card.sessionId);
      }

      if (!card.worktreeBranch && card.projectId) {
        const proj = await Project.findOneBy({ id: card.projectId });
        if (proj?.isGitRepo) {
          console.log(
            `[oc:auto-start] card #${card.id} left running → ${newColumn} ` +
              `(project=${card.projectId}), processing queue`,
          );
          processQueue(card.projectId).catch((err) => {
            console.error(`[oc:auto-start] processQueue failed for project ${card.projectId}:`, err);
          });
        }
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

function repo() {
  return AppDataSource.getRepository(Card);
}
