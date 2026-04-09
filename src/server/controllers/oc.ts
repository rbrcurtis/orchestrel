import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { messageBus, type MessageBus } from '../bus';
import { AppDataSource } from '../models/index';
import { processQueue } from '../services/queue-gate';

/**
 * Register per-card session event handlers.
 * Called when a session starts for a card — subscribes to bus topics
 * published by the consumer loop.
 */
export function registerCardSession(cardId: number): void {
  const repo = AppDataSource.getRepository(Card);

  // SDK messages: persist counters on result, reset context on compact
  const sdkHandler = async (payload: unknown) => {
    const msg = payload as Record<string, unknown>;
    if (msg.type === 'result') {
      const card = await repo.findOneBy({ id: cardId });
      if (!card) return;

      const initState = await import('../init-state');
      const sm = initState.getSessionManager();
      const session = sm?.get(cardId);
      if (session) {
        card.promptsSent = session.promptsSent;
        card.turnsCompleted = session.turnsCompleted;
        card.sessionId = session.sessionId;
      }

      card.updatedAt = new Date().toISOString();
      await repo.save(card);
    }

    if (msg.type === 'system') {
      const sys = msg as { subtype?: string; session_id?: string };

      // Session init: persist sessionId immediately so UI can show copy button
      if (sys.subtype === 'init' && sys.session_id) {
        const card = await repo.findOneBy({ id: cardId });
        if (card && !card.sessionId) {
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
  };

  // Exit: move to review if errored/stopped, unsubscribe
  const exitHandler = async (_rawPayload: unknown) => {
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

    messageBus.unsubscribe(`card:${cardId}:sdk`, sdkHandler);
    messageBus.unsubscribe(`card:${cardId}:exit`, exitHandler);
  };

  messageBus.subscribe(`card:${cardId}:sdk`, sdkHandler);
  messageBus.subscribe(`card:${cardId}:exit`, exitHandler);
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
      const sm = initState.getSessionManager();
      if (!sm) return;
      if (sm.isActive(card.id)) return; // Already started (e.g. by consumer init)

      const fullCard = await repo().findOneBy({ id: card.id });
      if (!fullCard) return;

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
      const prompt = fullCard.pendingPrompt ?? (fullCard.sessionId ? '' : fullCard.description ?? '');
      fullCard.pendingPrompt = null;
      fullCard.pendingFiles = null;
      await repo().save(fullCard);

      await sm.start(fullCard.id, prompt, {
        provider: fullCard.provider,
        model: fullCard.model,
        resume: fullCard.sessionId ?? undefined,
      });
      registerCardSession(fullCard.id);
    }

    // Card left running: stop + process queue
    if (oldColumn === 'running' && newColumn !== 'running') {
      const initState = await import('../init-state');
      const sm = initState.getSessionManager();
      sm?.stop(card.id);

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
