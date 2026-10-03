import { readdirSync, readFileSync, readlinkSync } from 'fs';
import { In, IsNull, Not } from 'typeorm';
import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { messageBus, type MessageBus } from '../bus';
import { AppDataSource } from '../models/index';
import { SYSTEM_AUTHOR, type OrcdMessage } from '../../shared/orcd-protocol';
import { resolveWorkDir } from '../../shared/worktree';
import { hasEnabledScheduledJobs } from '../../shared/scheduled-jobs';
import { wakeDueCard } from '../services/sleep';
import type { OrcdClient } from '../orcd-client';
import { windowForCard } from '../config/capabilities';

// ── Session → Card routing map ───────────────────────────────────────────────

const sessionCardMap = new Map<string, number>();
const bgcMap = new Map<string, number>();
const pendingAsyncAfterTurnComplete = new Map<string, boolean>();

// Cards whose ws handler is in the middle of `client.create()`. The column is
// set to 'running' optimistically before the orcd roundtrip so the board
// updates instantly; this set tells board:changed / agent:status reactors that
// the missing active session is expected, not a dead one.
const pendingCreates = new Set<number>();

export function markCreatePending(cardId: number): void {
  pendingCreates.add(cardId);
}

export function clearCreatePending(cardId: number): void {
  pendingCreates.delete(cardId);
}

export function isCreatePending(cardId: number): boolean {
  return pendingCreates.has(cardId);
}

/** Register a sessionId → cardId mapping so the global router can route messages. */
export function trackSession(cardId: number, sessionId: string): void {
  sessionCardMap.set(sessionId, cardId);
  console.log(`[orcd-router] tracking session ${sessionId.slice(0, 8)} → card ${cardId}`);
}

/** Remove a session from the routing map. */
export function untrackSession(sessionId: string): void {
  sessionCardMap.delete(sessionId);
}

/** Resolve the OrcdClient for a card's node. Returns null if the node has no client. */
async function clientForCard(card: { nodeName: string }): Promise<OrcdClient | null> {
  const initState = await import('../init-state');
  return initState.getClientByNode(card.nodeName);
}

function isBgcSystemEvent(
  event: Record<string, unknown>,
): event is { type: 'system'; subtype?: string; session_id?: string; message?: string } {
  return (
    event.type === 'system' &&
    (event.subtype === 'bgc_started' ||
      event.subtype === 'bgc_failed' ||
      event.subtype === 'compact_boundary' ||
      event.subtype === 'compact_started' ||
      event.subtype === 'compact_done')
  );
}

function routeBgcEvent(sessionId: string, event: Record<string, unknown>): number | undefined {
  if (!isBgcSystemEvent(event)) {
    console.log(`[orcd-router] routeBgcEvent: non-BGC event for session ${sessionId.slice(0, 8)}, skipping`);
    return undefined;
  }
  return bgcMap.get(sessionId);
}

// ── Global orcd message router ───────────────────────────────────────────────

const routedClients = new WeakSet<OrcdClient>();

export function initOrcdRouter(client: OrcdClient, bus: MessageBus = messageBus): void {
  if (routedClients.has(client)) {
    console.log(`[orcd-router] initOrcdRouter: client already routed, skipping`);
    return;
  }
  routedClients.add(client);
  const repo = () => AppDataSource.getRepository(Card);

  client.onMessage(async (msg: OrcdMessage) => {
    if (msg.type === 'sleep_due') {
      // orcd held the timer. Every connected backend hears this, so the wake is claimed
      // against the database before anything acts on it — exactly one wakes the card.
      const { wakeDueCard } = await import('../services/sleep');
      const woken = await wakeDueCard(msg.cardId).catch((err) => {
        console.error(`[sleep] wake for card ${msg.cardId} failed:`, err);
        return false;
      });
      console.log(`[orcd-router] sleep_due card ${msg.cardId} woken=${woken}`);
      return;
    }
    if (!('sessionId' in msg)) {
      console.log(`[orcd-router] dropping message with no sessionId: type=${msg.type}`);
      return;
    }
    let cardId = sessionCardMap.get(msg.sessionId);
    if (cardId == null && msg.type === 'stream_event') {
      const sdkEvent = msg.event as Record<string, unknown>;
      cardId = routeBgcEvent(msg.sessionId, sdkEvent);
    }
    if (cardId == null && (msg.type === 'session_exit' || msg.type === 'turn_complete')) {
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
      if (
        sdkEvent.type === 'message_start' ||
        sdkEvent.type === 'content_block_start' ||
        sdkEvent.type === 'content_block_delta' ||
        sdkEvent.type === 'content_block_stop' ||
        sdkEvent.type === 'message_stop' ||
        sdkEvent.type === 'message_delta'
      ) {
        bus.publish(`card:${cardId}:sdk`, { type: 'stream_event', event: sdkEvent });
      } else {
        bus.publish(`card:${cardId}:sdk`, sdkEvent);
      }

      // An assistant turn beginning means the agent is actively working again.
      // Card→review now fires only on agent_end (end of the whole run), so this
      // no longer fights per-turn flicker; it remains as a guard to pull a card
      // back to running if the agent resumes work while it sits in review
      // (e.g. a queued follow-up), so its state tracks the agent.
      const startMsg = sdkEvent.message as { role?: string } | undefined;
      if (sdkEvent.type === 'message_start' && startMsg?.role === 'assistant') {
        await handleTurnStart(cardId);
      }

      if (sdkEvent.type === 'system') {
        const sys = sdkEvent as { subtype?: string; session_id?: string; message?: string };

        if (sys.subtype === 'init' && sys.session_id) {
          const card = await repo().findOneBy({ id: cardId });
          if (card && (!card.sessionId || card.sessionId.startsWith('msg_'))) {
            card.sessionId = sys.session_id;
            card.updatedAt = new Date().toISOString();
            await repo().save(card);
            console.log(`[oc:${cardId}] init: persisted sessionId=${sys.session_id}`);
          }
        }

        if (sys.subtype === 'bgc_started' || sys.subtype === 'compact_started') {
          bgcMap.set(msg.sessionId, cardId);
          // A manual compact (button or /compact) runs no assistant turn, so
          // message_start never fires — move the card to running here so it shows
          // "turn started" while the compaction runs. No-op for an auto mid-run
          // BGC: the card is already running.
          await handleTurnStart(cardId);
        }

        // A failed BGC is terminal too, but it is not a compaction: leave the card's
        // context size alone, just stop routing its late events. If a manual compact
        // drove the card to running, bring it back the way a finished turn would.
        if (sys.subtype === 'bgc_failed') {
          bgcMap.delete(msg.sessionId);
          console.log(`[oc:${cardId}] bgc_failed: ${String(sys.message ?? 'no reason given')}`);
          await settleCompactCard(cardId, msg.sessionId);
        }

        if (sys.subtype === 'compact_boundary' || sys.subtype === 'compact_done') {
          const card = await repo().findOneBy({ id: cardId });
          if (card) {
            card.contextTokens = 1;
            // A compaction emits no turn_complete/session_exit, so return the card
            // to review here the same way a finished turn would — unless a live
            // agent run still owns the session (a mid-run BGC), in which case
            // turn_complete/session_exit settles the card.
            if (card.column === 'running' && !(await clientForCard(card))?.isActive(card.sessionId ?? ''))
              card.column = 'review';
            card.updatedAt = new Date().toISOString();
            await repo().save(card);
            console.log(`[oc:${cardId}] ${sys.subtype}: reset contextTokens to 1`);
          }
          bgcMap.delete(msg.sessionId);
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

    if (msg.type === 'turn_complete') {
      await handleTurnComplete(cardId, msg.sessionId, msg.hasPendingAsyncTasks, bus);
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
      await handleSessionExit(cardId, msg.sessionId, msg.state, bus);
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
      if (bgcMap.has(msg.sessionId)) {
        bgcMap.set(msg.newSessionId, cardId);
        bgcMap.delete(msg.sessionId);
      }
      if (pendingAsyncAfterTurnComplete.has(msg.sessionId)) {
        pendingAsyncAfterTurnComplete.set(msg.newSessionId, pendingAsyncAfterTurnComplete.get(msg.sessionId) === true);
        pendingAsyncAfterTurnComplete.delete(msg.sessionId);
      }
      console.log(`[oc:${cardId}] session forked: ${msg.sessionId.slice(0, 8)} → ${msg.newSessionId.slice(0, 8)}`);
    }
  });

  console.log('[orcd-router] global handler registered');
}

// ── Turn start / complete / Session exit ─────────────────────────────────────

async function handleTurnStart(cardId: number): Promise<void> {
  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });
  // Move to running only from a non-running, non-terminal column: already-
  // running is a no-op, and done/archive mean the card was parked there on
  // purpose — only an explicit prompt (which sets running itself) may pull it
  // back. Without this, a mid-turn drag to done would snap back on the next
  // assistant message.
  if (card && card.column !== 'running' && card.column !== 'done' && card.column !== 'archive') {
    const from = card.column;
    card.column = 'running';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
    console.log(`[oc:${cardId}] agent turn started → running (was ${from})`);
  }
}

/**
 * Settle a card whose only activity was a manual compaction: if it is sitting in
 * running and the session is no longer active, the compaction emitted no
 * turn_complete/session_exit to move it, so park it in review now.
 */
// oxlint-disable orchestrel/log-before-early-return -- high-frequency path: most
// bgc_failed events arrive mid-run with the card already settled elsewhere.
async function settleCompactCard(cardId: number, sessionId: string): Promise<void> {
  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });
  if (!card || card.column !== 'running') return;
  if ((await clientForCard(card))?.isActive(card.sessionId ?? sessionId)) return;
  // oxlint-enable orchestrel/log-before-early-return
  card.column = 'review';
  card.updatedAt = new Date().toISOString();
  await repo.save(card);
  console.log(`[oc:${cardId}] compact finished → review`);
}

async function handleTurnComplete(
  cardId: number,
  sessionId: string,
  hasPendingAsyncTasks: boolean,
  bus: MessageBus = messageBus,
): Promise<void> {
  pendingAsyncAfterTurnComplete.set(sessionId, hasPendingAsyncTasks);

  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });
  if (card && card.column === 'running') {
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
  }

  bus.publish(`card:${cardId}:sdk`, {
    type: 'turn_complete',
    session_id: sessionId,
    has_pending_async_tasks: hasPendingAsyncTasks,
  });
}

async function handleSessionExit(
  cardId: number,
  sessionId: string,
  status: 'completed' | 'errored' | 'stopped',
  bus: MessageBus = messageBus,
): Promise<void> {
  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });

  const hadPendingAsyncAfterTurn = pendingAsyncAfterTurnComplete.get(sessionId) === true;
  pendingAsyncAfterTurnComplete.delete(sessionId);

  // The session is gone, so nothing else will ever settle the card: park whatever is
  // still running, whatever the run's outcome. An errored exit used to be exempt, which
  // left the card in running with no session behind it until the next orcd reconnect
  // reconciled it.
  if (card && card.column === 'running') {
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
  } else if (
    card &&
    status !== 'errored' &&
    hadPendingAsyncAfterTurn &&
    card.column !== 'archive' &&
    card.column !== 'done' &&
    card.column !== 'review'
  ) {
    // Background/async work that kept the session alive after the turn
    // finished — surface the card in review so Ryan sees the new output. An errored
    // session is left where it is: its failure is already on the session.
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
  }

  // A card moved to done/archive mid-turn kept its session alive to finish the
  // work, and the board:changed reaper deferred killing its worktree processes
  // for that reason. The session has now exited — anything still running in the
  // worktree is an orphan, so reap it based on the card's current column.
  if (card && card.column !== 'running' && card.column !== 'review' && card.worktreeBranch && card.projectId) {
    const { Project } = await import('../models/Project');
    const proj = await Project.findOneBy({ id: card.projectId });
    if (proj) {
      const { resolveWorkDir } = await import('../../shared/worktree');
      const wt = resolveWorkDir(card.worktreeBranch, proj.path);
      const reaped = reapWorktreeProcesses(wt);
      console.log(`[reaper] card ${cardId} session exit in ${card.column}: reaped ${reaped} process(es) under ${wt}`);
    }
  }

  // If the card was archived while its session kept running, the board:changed
  // handler deferred worktree cleanup to avoid breaking the live session.
  // Now that the session has actually exited, remove the worktree.
  if (card && card.column === 'archive') {
    await cleanupWorktreeForCard(card);
  }

  bus.publish(`card:${cardId}:exit`, {
    sessionId: card?.sessionId,
    status,
  });
}

// ── Per-node sync ───────────────────────────────────────────────────────────

/**
 * Work that outlives one node's pass. Projects are loaded once and the scheduled-job
 * probe is memoized per worktree, because the same few projects and worktrees come up
 * again for every card and every node.
 */
export interface SyncContext {
  projects: Map<number, Project>;
  worktreeJobs: Map<string, boolean>;
}

export async function createSyncContext(): Promise<SyncContext> {
  const projects = await AppDataSource.getRepository(Project).find();
  return { projects: new Map(projects.map((p) => [p.id, p])), worktreeJobs: new Map() };
}

/**
 * Bring one node's cards in line with what its orcd actually holds, then re-arm the
 * timers orcd keeps in memory only.
 *
 * orcd's session list is the source of truth: client.isActive() reads an in-memory
 * cache that is empty after an orchestrel restart. Every query filters by this node in
 * SQL and selects only the columns the pass reads. The previous shape hydrated every
 * card twice per node and filtered afterwards, and could hand another node's card to
 * this daemon's warm(), which creates the session it is asked to warm.
 */
export async function syncNode(client: OrcdClient, ctx: SyncContext, bus: MessageBus = messageBus): Promise<void> {
  const repo = AppDataSource.getRepository(Card);
  const node = client.nodeName;

  const sessions = await client.list();
  const live = new Set(sessions.sessions.filter((s) => s.state === 'running').map((s) => s.id));

  // Re-seed in-memory isActive tracking + router mapping for every live session that
  // maps to a card on this node. isActive() then tells the truth, so auto-start and
  // agent:send detect an existing session and route through create (which passes
  // summarizeThreshold + attaches the lifecycle hooks).
  const liveCards = live.size
    ? await repo.find({ where: { sessionId: In([...live]), nodeName: node }, select: ['id', 'sessionId'] })
    : [];
  for (const card of liveCards) {
    const sessionId = card.sessionId as string;
    client.markActive(sessionId);
    client.trackCard(sessionId);
    trackSession(card.id, sessionId);
    console.log(`[reconcile] re-seeded tracking for card ${card.id} session ${sessionId.slice(0, 8)}`);
  }

  // Settle the running column. A card with no sessionId is still in the pre-session
  // starting window and stays in running: start what never started, park what died.
  // Another node's session list never holds this node's sessions, so the node filter
  // is what keeps those cards from being parked or started on the wrong daemon.
  const runningCards = await repo.find({ where: { column: 'running', nodeName: node } });
  for (const card of runningCards) {
    if (card.sessionId && live.has(card.sessionId)) {
      console.log(`[reconcile] card ${card.id} still active in orcd`);
      continue;
    }
    if (!card.sessionId) {
      console.log(`[reconcile] card ${card.id} has no sessionId; starting missed session`);
      await startCardSession(client, card, bus);
      continue;
    }

    untrackSession(card.sessionId);
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
    console.log(`[reconcile] card ${card.id} moved to review (session not in orcd)`);
    bus.publish(`card:${card.id}:exit`, {
      sessionId: card.sessionId,
      status: 'stopped',
    });
  }

  const warmed = await rearmScheduledSessions(client, live, ctx);
  const armed = await rearmSleepWakes(client);
  console.log(
    `[sync] node ${node}: ${live.size} live session(s), ${runningCards.length} running card(s), ${warmed} warmed, ${armed} wake(s) armed`,
  );
}

// Re-arm scheduled background agents after an orcd restart. The pi-subagents
// scheduler's timers live only in orcd memory, so a restart drops them; the enabled
// jobs persist on disk in each worktree. For every card on this node whose worktree
// still has an enabled job, ask orcd to warm (resume + hold) the session so the
// scheduler re-arms and the job fires at its time. Column-independent: a job fires
// whether the card sits in review, done, etc. warm() no-ops when the session is
// already resident.
async function rearmScheduledSessions(client: OrcdClient, live: Set<string>, ctx: SyncContext): Promise<number> {
  const repo = AppDataSource.getRepository(Card);
  const cards = await repo.find({
    where: { nodeName: client.nodeName, projectId: Not(IsNull()), sessionId: Not(IsNull()) },
    select: [
      'id',
      'sessionId',
      'sessionCwd',
      'worktreeBranch',
      'projectId',
      'provider',
      'model',
      'nodeName',
      'contextWindow',
      'summarizeThreshold',
    ],
  });

  let warmed = 0;
  for (const card of cards) {
    const sessionId = card.sessionId as string;
    if (live.has(sessionId)) continue;
    const proj = card.projectId == null ? undefined : ctx.projects.get(card.projectId);
    if (!proj) continue;
    const cwd = card.sessionCwd ?? (card.worktreeBranch ? resolveWorkDir(card.worktreeBranch, proj.path) : null);
    if (!cwd || !hasJobsIn(cwd, ctx)) continue;

    try {
      console.log(`[rearm] card ${card.id} has scheduled jobs; warming session ${sessionId.slice(0, 8)}`);
      await client.warm({
        sessionId,
        cwd,
        provider: card.provider,
        model: card.model,
        contextWindow: windowForCard(card),
        summarizeThreshold: card.summarizeThreshold,
      });
      trackSession(card.id, sessionId);
      warmed++;
    } catch (err) {
      console.error(`[rearm] card ${card.id} warm failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return warmed;
}

/** The scheduled-job probe hits the filesystem, and cards share worktrees. */
function hasJobsIn(cwd: string, ctx: SyncContext): boolean {
  let found = ctx.worktreeJobs.get(cwd);
  if (found === undefined) {
    found = hasEnabledScheduledJobs(cwd);
    ctx.worktreeJobs.set(cwd, found);
  }
  return found;
}

// orcd keeps only in-memory timers, so the rows are re-registered here: a wake that
// came due while this node was unreachable happens now.
async function rearmSleepWakes(client: OrcdClient, now = Date.now()): Promise<number> {
  const repo = AppDataSource.getRepository(Card);
  const cards = await repo.find({
    where: { column: 'ready', nodeName: client.nodeName },
    select: ['id', 'sleepUntil'],
  });

  let armed = 0;
  for (const card of cards) {
    if (card.sleepUntil == null) continue;
    if (card.sleepUntil <= now) {
      await wakeDueCard(card.id, now);
      continue;
    }
    client.scheduleSleep(card.id, card.sleepUntil);
    armed++;
  }
  return armed;
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
      const client = await clientForCard(card);
      if (!client) {
        console.log(`[oc:auto-start] card #${card.id} node ${card.nodeName} has no client, skipping`);
        return;
      }
      if (!client.isConnected()) {
        console.log(`[oc:auto-start] card #${card.id} node ${card.nodeName} offline, skipping`);
        return;
      }

      // afterInsert publishes board:changed before the insert transaction
      // commits, so the re-read can race the insert and see nothing. Retry
      // once after the commit lands before declaring the card gone.
      let fullCard = await repo().findOneBy({ id: card.id });
      if (!fullCard) {
        await new Promise((r) => setTimeout(r, 300));
        fullCard = await repo().findOneBy({ id: card.id });
      }
      if (!fullCard) {
        console.log(`[oc:auto-start] card #${card.id} vanished before auto-start`);
        return;
      }

      // Check if already active in orcd
      if (fullCard.sessionId && client.isActive(fullCard.sessionId)) {
        console.log(`[oc:auto-start] card #${card.id} session ${fullCard.sessionId.slice(0, 8)} already active`);
        return;
      }

      // A prompt submitted via ws already set the column and is creating the
      // session itself — auto-starting here would spawn a duplicate session
      // with the description as prompt.
      if (isCreatePending(card.id)) {
        console.log(`[oc:auto-start] card #${card.id} create already in flight from ws handler, skipping`);
        return;
      }

      console.log(
        `[oc:auto-start] card #${card.id} entered running ` +
          `(worktree=${!!card.worktreeBranch}, project=${card.projectId})`,
      );
      await startCardSession(client, fullCard, bus);
    }
  });
}

// Remove the worktree for an archived card. Returns true if a removal was
// attempted/completed, false if there was nothing to clean up.
async function cleanupWorktreeForCard(card: Card): Promise<void> {
  if (!card.worktreeBranch || !card.projectId) {
    console.log(`[oc:worktree] card ${card.id} has no worktree/project, skipping cleanup`);
    return;
  }

  try {
    const { Project } = await import('../models/Project');
    const proj = await Project.findOneBy({ id: card.projectId });
    if (!proj) {
      console.log(`[oc:worktree] card ${card.id} project ${card.projectId} not found, skipping cleanup`);
      return;
    }

    const client = await clientForCard(card);
    if (!client || !client.isConnected()) {
      console.log(`[oc:worktree] card ${card.id} node ${card.nodeName} offline, skipping cleanup (best-effort)`);
      return;
    }
    const { resolveWorkDir } = await import('../../shared/worktree');
    const wtPath = resolveWorkDir(card.worktreeBranch, proj.path);
    await client.worktreeRemove(proj.path, wtPath);
    console.log(`[oc:worktree] removed ${wtPath} on node ${card.nodeName}`);
  } catch (err) {
    console.error(`[oc:worktree] cleanup failed for card ${card.id}:`, err);
    // handled: cleanup failure is non-fatal
  }
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
      console.log(
        `[oc:worktree] card ${card.id} column ${oldColumn} → ${newColumn}: not a fresh archive transition, skipping cleanup`,
      );
      return;
    }

    // Archiving no longer kills a live session — the agent may still be running
    // a final fire-and-forget command in its worktree. Removing it now would
    // break that session, so defer cleanup until session_exit fires.
    const client = await clientForCard(card);
    if (card.sessionId && client?.isActive(card.sessionId)) {
      console.log(
        `[oc:worktree] card ${card.id} archived with live session ${card.sessionId.slice(0, 8)}, deferring worktree cleanup to session_exit`,
      );
      return;
    }

    await cleanupWorktreeForCard(card);
  });
}

// Kill stray processes a session left running in its worktree — e.g. the
// `sleep 900` background poll loops Pi spawns but never reaps when the agent
// session exits (they orphan onto the orcd process and pile up, holding GBs of
// RAM). Attribution is by working directory, so it only touches processes that
// belong to THIS card's worktree and never another live session's. Once the
// worktree dir has been removed (archive cleanup) the kernel appends a
// " (deleted)" suffix to the cwd symlink target — strip it before comparing.
// The trailing-slash guard prevents a prefix collision between sibling
// worktrees (e.g. `neural-engine` vs `neural-engine-optimization`).
// True when a process working directory belongs to `worktree`. Strips the
// kernel's " (deleted)" suffix (present after the worktree dir is removed) and
// uses a trailing-slash guard so a sibling worktree whose path is a string
// prefix (e.g. `neural-engine` vs `neural-engine-optimization`) is NOT matched.
export function cwdMatchesWorktree(rawCwd: string, worktree: string): boolean {
  const cwd = rawCwd.replace(/ \(deleted\)$/, '');
  return cwd === worktree || cwd.startsWith(`${worktree}/`);
}

// True when the process has a controlling TTY (tty_nr, field 7 of
// /proc/pid/stat, is nonzero). Interactive shells and anything Ryan runs in a
// terminal have one; agent-spawned orphans run under orcd with no TTY. The
// comm field (parenthesized, may contain spaces/parens) is skipped by parsing
// after the LAST ')'; tty_nr is then the 5th space-separated field.
export function statHasControllingTty(stat: string): boolean {
  const rest = stat.slice(stat.lastIndexOf(')') + 1).trim();
  const ttyNr = rest.split(' ')[4];
  return ttyNr !== undefined && ttyNr !== '0';
}

/* oxlint-disable orchestrel/log-in-catch, orchestrel/log-before-early-return --
   per-pid /proc scan: catches fire for every process that exits mid-scan or
   isn't readable; logging each one would be pure noise. The caller logs the
   total reaped count. */
function reapWorktreeProcesses(worktree: string): number {
  let pids: string[];
  try {
    pids = readdirSync('/proc');
  } catch {
    return 0;
  }
  const self = process.pid;
  let killed = 0;
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === self) continue;
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue; // process gone or not ours
    }
    if (!cwdMatchesWorktree(cwd, worktree)) continue;
    // Never kill interactive processes — a terminal cd'd into the worktree is
    // Ryan's, not an orphaned agent task.
    try {
      if (statHasControllingTty(readFileSync(`/proc/${pid}/stat`, 'utf8'))) continue;
    } catch {
      continue; // process gone mid-scan
    }
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {
      // already gone — fine
    }
  }
  return killed;
}
/* oxlint-enable orchestrel/log-in-catch, orchestrel/log-before-early-return */

// Reap a card's leftover worktree processes whenever it lands in a column that
// isn't active work. running/review may legitimately have live background
// tasks; done/ready/archive/backlog must not, so anything still running in the
// worktree is an orphan and gets killed. Independent board:changed listener:
// order-independent (strips " (deleted)" so it composes with worktree cleanup
// regardless of which fires first) and assumes nothing about prior steps.
export function registerProcessReaper(bus: MessageBus = messageBus): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) {
      console.log(`[reaper] board:changed with null card, skipping`);
      return;
    }
    // running/review may have live background work — leave it alone. (High
    // frequency; intentionally silent.)
    // oxlint-disable-next-line orchestrel/log-before-early-return
    if (newColumn === 'running' || newColumn === 'review') return;

    // A live session means the card was parked here mid-turn (e.g. a fire-and-
    // forget prompt moved to done/archive without waiting for the reply). Its
    // processes are still in use — reaping them would kill the running turn.
    // handleSessionExit reaps based on the column once the session ends.
    const client = await clientForCard(card);
    if (card.sessionId && client?.isActive(card.sessionId)) {
      console.log(
        `[reaper] card ${card.id} → ${newColumn}: live session ${card.sessionId.slice(0, 8)}, deferring to session_exit`,
      );
      return;
    }

    if (!card.worktreeBranch || !card.projectId) {
      console.log(`[reaper] card ${card.id} → ${newColumn}: no worktree, skipping`);
      return;
    }

    const { Project } = await import('../models/Project');
    const proj = await Project.findOneBy({ id: card.projectId });
    if (!proj) {
      console.log(`[reaper] card ${card.id} → ${newColumn}: project ${card.projectId} not found, skipping`);
      return;
    }

    const { resolveWorkDir } = await import('../../shared/worktree');
    const wt = resolveWorkDir(card.worktreeBranch, proj.path);
    const n = reapWorktreeProcesses(wt);
    console.log(`[reaper] card ${card.id} → ${newColumn}: reaped ${n} process(es) under ${wt}`);
  });
}

function repo() {
  return AppDataSource.getRepository(Card);
}

async function markSessionStartFailed(bus: MessageBus, card: Card, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[session:${card.id}] failed to start session:`, msg);

  card.column = 'review';
  card.updatedAt = new Date().toISOString();
  await repo().save(card);
  bus.publish(`card:${card.id}:exit`, {
    sessionId: card.sessionId ?? null,
    status: 'errored',
  });
}

async function startCardSession(client: OrcdClient, card: Card, bus: MessageBus = messageBus): Promise<string | null> {
  try {
    const { ensureWorktree } = await import('../sessions/worktree');
    const cwd = await ensureWorktree(card, client);
    const startedFromDescription = !card.sessionId;
    let prompt = card.sessionId ? '' : card.description || card.title;
    const pending = card.sessionId ? [] : (card.pendingInitialFiles ?? []);
    if (pending.length > 0) {
      const { readAttachment } = await import('../attachments');
      const { buildPromptWithFiles } = await import('../sessions/manager');
      const staged = [];
      for (const file of pending) {
        staged.push(
          await client.stageFile({
            cardId: card.id,
            file,
            bytes: readAttachment(file),
          }),
        );
      }
      prompt = buildPromptWithFiles(prompt, staged);
    }

    const effort = card.thinkingLevel === 'off' ? 'disabled' : card.thinkingLevel;
    // Heal the persisted context window from the node's live capabilities (the
    // node is connected here). See windowForCard for why the cache drifts.
    const window = windowForCard(card);
    const sessionId = await client.create({
      prompt,
      cwd,
      provider: card.provider,
      model: card.model,
      sessionId: card.sessionId ?? undefined,
      contextWindow: window,
      summarizeThreshold: card.summarizeThreshold,
      effort,
      author: SYSTEM_AUTHOR,
    });

    card.sessionId = sessionId;
    card.contextWindow = window;
    client.trackCard(sessionId);
    if (pending.length > 0) card.pendingInitialFiles = [];
    // The card description is the first prompt sent. Follow-up prompts increment
    // promptsSent in the ws message handler; this covers the initial start.
    if (startedFromDescription) card.promptsSent = (card.promptsSent ?? 0) + 1;
    trackSession(card.id, sessionId);
    card.updatedAt = new Date().toISOString();
    await repo().save(card);
    if (pending.length > 0) {
      const { deleteAttachments } = await import('../attachments');
      deleteAttachments(pending);
    }

    console.log(`[session:${card.id}] session started: ${sessionId.slice(0, 8)}`);
    return sessionId;
  } catch (err) {
    console.error(`[session:${card.id}] startCardSession error:`, err instanceof Error ? err.message : String(err));
    await markSessionStartFailed(bus, card, err);
    console.log(`[session:${card.id}] startCardSession returning null after failure`);
    return null;
  }
}
