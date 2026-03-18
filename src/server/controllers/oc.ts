import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { messageBus, type MessageBus } from '../bus';
import type { AgentSession, AgentMessage } from '../agents/types';

const DISPLAY_TYPES = new Set([
  'user',
  'text',
  'tool_call',
  'tool_result',
  'tool_progress',
  'thinking',
  'system',
  'turn_end',
  'error',
  'subagent',
]);

/**
 * Wire independent event handlers on an OC session.
 * Each handler is a separate session.on() call — no handler blocks another.
 * The bus parameter defaults to the singleton for production; tests inject a fresh instance.
 */
export function wireSession(cardId: number, session: AgentSession, bus: MessageBus = messageBus): void {
  // Handler: forward displayable content to domain bus
  session.on('message', (msg: AgentMessage) => {
    if (!DISPLAY_TYPES.has(msg.type)) return;
    bus.publish(`card:${cardId}:message`, msg);
  });

  // Handler: if messages arrive for a card not in running, move it back.
  // This handles the case where the agent keeps producing output after a
  // failed stop attempt or after the card was moved away prematurely.
  const CONTENT_TYPES = new Set(['text', 'tool_call', 'thinking']);
  let cardMoveInFlight = false;
  session.on('message', async (msg: AgentMessage) => {
    if (!CONTENT_TYPES.has(msg.type) || cardMoveInFlight) return;
    try {
      cardMoveInFlight = true;
      const card = await Card.findOneBy({ id: cardId });
      if (card && card.column !== 'running' && card.column !== 'archive' && card.column !== 'done') {
        console.log(`[oc:${cardId}] message arrived while card in ${card.column} — moving to running`);
        card.column = 'running';
        card.updatedAt = new Date().toISOString();
        await card.save();
      }
    } catch (err) {
      console.error(`[oc:${cardId}] failed to move card to running on message:`, err);
    } finally {
      cardMoveInFlight = false;
    }
  });

  // Handler: persist counters + move card to review on turn_end
  // These MUST be in one handler to avoid a lost-update race (both would
  // load the same row, mutate different fields, and the last save wins).
  session.on('message', async (msg: AgentMessage) => {
    if (msg.type !== 'turn_end') return;
    try {
      const card = await Card.findOneBy({ id: cardId });
      if (!card) return;
      card.promptsSent = session.promptsSent;
      card.turnsCompleted = session.turnsCompleted;
      if (msg.usage) {
        const u = msg.usage;
        card.contextTokens = (u.inputTokens ?? 0) + (u.cacheWrite ?? 0) + (u.cacheRead ?? 0);
        if (u.contextWindow) card.contextWindow = u.contextWindow;
      }
      if (card.column === 'running') card.column = 'review';
      card.updatedAt = new Date().toISOString();
      await card.save();
    } catch (err) {
      console.error(`[oc:${cardId}] failed to handle turn_end:`, err);
    }
  });

  // Handler: move card to review on exit (errored/stopped only)
  session.on('exit', async () => {
    if (session.status === 'errored' || session.status === 'stopped') {
      try {
        const card = await Card.findOneBy({ id: cardId });
        if (card && card.column === 'running') {
          card.column = 'review';
          card.promptsSent = session.promptsSent;
          card.turnsCompleted = session.turnsCompleted;
          // contextTokens/contextWindow already persisted by turn_end handler
          card.updatedAt = new Date().toISOString();
          await card.save();
        }
      } catch (err) {
        console.error(`[oc:${cardId}] failed to move card to review on exit:`, err);
      }
    }
  });

  // Handler: publish exit status to domain bus
  session.on('exit', () => {
    bus.publish(`card:${cardId}:exit`, {
      cardId,
      active: false,
      status: session.status,
      sessionId: session.sessionId,
      promptsSent: session.promptsSent,
      turnsCompleted: session.turnsCompleted,
      contextTokens: 0,
      contextWindow: 200_000,
    });
  });

  // Handler: forward session status changes to domain bus
  // If session goes to running but card isn't in running column, move it back
  session.on('statusChange', async () => {
    if (session.status === 'running') {
      try {
        const card = await Card.findOneBy({ id: cardId });
        if (card && card.column !== 'running' && card.column !== 'archive' && card.column !== 'done') {
          card.column = 'running';
          card.updatedAt = new Date().toISOString();
          await card.save();
        }
      } catch (err) {
        console.error(`[oc:${cardId}] failed to move card to running on statusChange:`, err);
      }
    }
    bus.publish(`card:${cardId}:session-status`, {
      cardId,
      active: session.status === 'running' || session.status === 'starting' || session.status === 'retry',
      status: session.status,
      sessionId: session.sessionId,
      promptsSent: session.promptsSent,
      turnsCompleted: session.turnsCompleted,
      contextTokens: 0,
      contextWindow: 200_000,
    });
  });
}

// --- Domain bus listeners (registered once at startup) ---

interface SessionStarter {
  startSession(cardId: number, message?: string): Promise<void>;
  attachSession(cardId: number): Promise<boolean>;
}

export function registerAutoStart(bus: MessageBus = messageBus, starter: SessionStarter): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;
    if (newColumn !== 'running') return;
    if (oldColumn === 'running') return;

    // Already queued — nothing to do
    if (card.queuePosition != null) return;

    // Non-worktree cards: check for conflict group before starting
    if (!card.useWorktree && card.projectId) {
      const others = await Card.find({
        where: {
          column: 'running',
          projectId: card.projectId,
          useWorktree: false as unknown as boolean,
        },
      });
      const conflict = others.filter((c) => c.id !== card.id);
      if (conflict.length > 0) {
        // Assign queue position: max existing + 1
        const maxPos = conflict.reduce((mx, c) => Math.max(mx, c.queuePosition ?? 0), 0);
        const fresh = await Card.findOneBy({ id: card.id });
        if (fresh) {
          fresh.queuePosition = maxPos + 1;
          fresh.updatedAt = new Date().toISOString();
          await fresh.save();
        }
        return;
      }
    }

    // Card with existing session — try to attach if OC session is still alive
    if (card.sessionId) {
      try {
        const attached = await starter.attachSession(card.id);
        if (attached) {
          console.log(`[oc:auto-start] attached to live session for card ${card.id}`);
          return;
        }
        // Session not alive — fall through to startSession (resume with existing sessionId)
        console.log(`[oc:auto-start] session not active for card ${card.id}, will resume`);
      } catch (err) {
        console.error(`[oc:auto-start] attach failed for card ${card.id}:`, err);
      }
    }

    starter.startSession(card.id, undefined).catch((err) => {
      console.error(`[oc:auto-start] failed for card ${card.id}:`, err);
    });
  });
}

interface QueueStarter {
  startSession(cardId: number): Promise<void>;
}

export function registerQueueManager(bus: MessageBus = messageBus, starter: QueueStarter): void {
  bus.subscribe('queue:promoted', async (payload) => {
    const { cardId } = payload as { cardId: number };
    starter.startSession(cardId).catch((err) => {
      console.error(`[oc:queue] failed to start promoted card ${cardId}:`, err);
    });
  });
}

interface WorktreeOps {
  removeWorktree(repoPath: string, worktreePath: string): void;
  worktreeExists(worktreePath: string): boolean;
}

export function registerWorktreeCleanup(bus: MessageBus = messageBus, ops: WorktreeOps): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;
    if (newColumn !== 'archive' || oldColumn === 'archive') return;

    const c = card as Card;
    if (!c.useWorktree || !c.worktreePath || !c.projectId) return;

    try {
      const proj = await Project.findOneBy({ id: c.projectId });
      if (!proj || !ops.worktreeExists(c.worktreePath)) return;
      ops.removeWorktree(proj.path, c.worktreePath);
      console.log(`[oc:worktree] removed ${c.worktreePath}`);

      // Clear worktree path so re-entering running recreates the worktree
      // sessionId is preserved — resume will pick up the conversation
      const fresh = await Card.findOneBy({ id: c.id });
      if (fresh) {
        fresh.worktreePath = null;
        fresh.updatedAt = new Date().toISOString();
        await fresh.save();
      }
    } catch (err) {
      console.error(`[oc:worktree] cleanup failed for card ${c.id}:`, err);
    }
  });
}
