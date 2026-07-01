import { readdirSync, readlinkSync } from 'fs';
import { Card } from '../models/Card';
import { messageBus, type MessageBus } from '../bus';
import { AppDataSource } from '../models/index';
import type { OrcdMessage } from '../../shared/orcd-protocol';
import type { OrcdClient } from '../orcd-client';

// ── Session → Card routing map ───────────────────────────────────────────────

const sessionCardMap = new Map<string, number>();
const bgcMap = new Map<string, number>();
const pendingAsyncAfterTurnComplete = new Map<string, boolean>();

/** Register a sessionId → cardId mapping so the global router can route messages. */
export function trackSession(cardId: number, sessionId: string): void {
  sessionCardMap.set(sessionId, cardId);
  console.log(`[orcd-router] tracking session ${sessionId.slice(0, 8)} → card ${cardId}`);
}

/** Remove a session from the routing map. */
export function untrackSession(sessionId: string): void {
  sessionCardMap.delete(sessionId);
}

function isBgcSystemEvent(event: Record<string, unknown>): event is { type: 'system'; subtype?: string; session_id?: string } {
  return (
    event.type === 'system' &&
    (event.subtype === 'bgc_started' ||
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

        if (sys.subtype === 'bgc_started' || sys.subtype === 'compact_started') {
          bgcMap.set(msg.sessionId, cardId);
        }

        if (sys.subtype === 'compact_boundary' || sys.subtype === 'compact_done') {
          const card = await repo().findOneBy({ id: cardId });
          if (card) {
            card.contextTokens = 1;
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
      console.log(`[oc:${cardId}] session forked: ${msg.sessionId.slice(0,8)} → ${msg.newSessionId.slice(0,8)}`);
    }
  });

  console.log('[orcd-router] global handler registered');
}

// ── Turn start / complete / Session exit ─────────────────────────────────────

async function handleTurnStart(cardId: number): Promise<void> {
  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });
  // Move to running only from a non-running, non-archive column: already-running
  // is a no-op, and archive means the card was intentionally pulled off the board.
  if (card && card.column !== 'running' && card.column !== 'archive') {
    const from = card.column;
    card.column = 'running';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
    console.log(`[oc:${cardId}] agent turn started → running (was ${from})`);
  }
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

  if (card && status !== 'errored') {
    if (card.column === 'running') {
      card.column = 'review';
      card.updatedAt = new Date().toISOString();
      await repo.save(card);
    } else if (hadPendingAsyncAfterTurn && card.column !== 'archive' && card.column !== 'review') {
      // Background/async work that kept the session alive after the turn
      // finished — surface the card in review so Ryan sees the new output.
      card.column = 'review';
      card.updatedAt = new Date().toISOString();
      await repo.save(card);
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

  // Reconcile running-column cards whose session is no longer alive in orcd.
  // Cards with no sessionId are still in the pre-session starting window and stay in running.
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
    if (!card.sessionId) {
      console.log(`[reconcile] card ${card.id} has no sessionId; starting missed session`);
      await startCardSession(client, card, bus);
      continue;
    }

    untrackSession(card.sessionId);
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await r.save(card);
    console.log(`[reconcile] card ${card.id} moved to review (session not in orcd)`);
    bus.publish(`card:${card.id}:exit`, {
      sessionId: card.sessionId,
      status: 'stopped',
    });
  }
}

// Re-arm scheduled background agents after an orcd restart. The pi-subagents
// scheduler's timers live only in orcd memory, so a restart drops them; the
// enabled jobs persist on disk in each worktree. For every card whose worktree
// still has an enabled scheduled job, ask orcd to warm (resume + hold) the
// session so the scheduler re-arms and the job fires at its time. Column-
// independent: a job fires whether the card sits in review, done, etc. Runs at
// startup and on every orcd reconnect — warm() no-ops if already resident.
export async function rearmScheduledSessions(client: OrcdClient): Promise<void> {
  const r = AppDataSource.getRepository(Card);
  const cards = await r.find();
  const { Project } = await import('../models/Project');
  const { resolveWorkDir } = await import('../../shared/worktree');
  const { hasEnabledScheduledJobs } = await import('../../shared/scheduled-jobs');

  let warmed = 0;
  for (const card of cards) {
    if (!card.sessionId || !card.worktreeBranch || !card.projectId) continue;
    if (client.isActive(card.sessionId)) continue;
    const proj = await Project.findOneBy({ id: card.projectId });
    if (!proj) continue;
    const wt = resolveWorkDir(card.worktreeBranch, proj.path);
    if (!hasEnabledScheduledJobs(wt)) continue;

    try {
      console.log(`[rearm] card ${card.id} has scheduled jobs; warming session ${card.sessionId.slice(0, 8)}`);
      await client.warm({
        sessionId: card.sessionId,
        cwd: wt,
        provider: card.provider,
        model: card.model,
        contextWindow: card.contextWindow,
        summarizeThreshold: card.summarizeThreshold,
      });
      trackSession(card.id, card.sessionId);
      warmed++;
    } catch (err) {
      console.error(`[rearm] card ${card.id} warm failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`[rearm] scanned ${cards.length} cards, warmed ${warmed} with scheduled jobs`);
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

    const { resolveWorkDir } = await import('../../shared/worktree');
    const wtPath = resolveWorkDir(card.worktreeBranch, proj.path);
    const { removeWorktree, worktreeExists } = await import('../worktree');
    if (worktreeExists(wtPath)) {
      removeWorktree(proj.path, wtPath);
      console.log(`[oc:worktree] removed ${wtPath}`);
    }
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
      console.log(`[oc:worktree] card ${card.id} column ${oldColumn} → ${newColumn}: not a fresh archive transition, skipping cleanup`);
      return;
    }

    // Archiving no longer kills a live session — the agent may still be running
    // a final fire-and-forget command in its worktree. Removing it now would
    // break that session, so defer cleanup until session_exit fires.
    const initState = await import('../init-state');
    const client = initState.getOrcdClient();
    if (card.sessionId && client?.isActive(card.sessionId)) {
      console.log(`[oc:worktree] card ${card.id} archived with live session ${card.sessionId.slice(0, 8)}, deferring worktree cleanup to session_exit`);
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

async function markSessionStartFailed(
  bus: MessageBus,
  card: Card,
  err: unknown,
): Promise<void> {
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

async function startCardSession(
  client: OrcdClient,
  card: Card,
  bus: MessageBus = messageBus,
): Promise<string | null> {
  try {
    const { ensureWorktree } = await import('../sessions/worktree');
    const cwd = await ensureWorktree(card);
    const startedFromDescription = !card.sessionId;
    const prompt = card.sessionId ? '' : card.description ?? '';

    const effort = card.thinkingLevel === 'off' ? 'disabled' : card.thinkingLevel;
    const sessionId = await client.create({
      prompt,
      cwd,
      provider: card.provider,
      model: card.model,
      sessionId: card.sessionId ?? undefined,
      contextWindow: card.contextWindow,
      summarizeThreshold: card.summarizeThreshold,
      effort,
    });

    card.sessionId = sessionId;
    // The card description is the first prompt sent. Follow-up prompts increment
    // promptsSent in the ws message handler; this covers the initial start.
    if (startedFromDescription) card.promptsSent = (card.promptsSent ?? 0) + 1;
    trackSession(card.id, sessionId);
    card.updatedAt = new Date().toISOString();
    await repo().save(card);

    console.log(`[session:${card.id}] session started: ${sessionId.slice(0, 8)}`);
    return sessionId;
  } catch (err) {
    console.error(`[session:${card.id}] startCardSession error:`, err instanceof Error ? err.message : String(err));
    await markSessionStartFailed(bus, card, err);
    console.log(`[session:${card.id}] startCardSession returning null after failure`);
    return null;
  }
}
