import { Card } from '../models/Card';

const projectLocks = new Map<number, Promise<void>>();

/**
 * Process the queue for a project's non-worktree running cards.
 * If a session is active, ensures queue positions are correct.
 * If no session is active, promotes the next card and starts it.
 * Serialized per-project to prevent race conditions.
 */
export function processQueue(projectId: number): Promise<void> {
  const prev = projectLocks.get(projectId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => processQueueImpl(projectId));
  projectLocks.set(projectId, next);
  return next;
}

async function processQueueImpl(projectId: number): Promise<void> {
  const group = await Card.find({
    where: {
      column: 'running',
      projectId,
      useWorktree: false as unknown as boolean,
    },
    order: { queuePosition: 'ASC' },
  });

  if (group.length === 0) {
    console.log(`[queue-gate] project=${projectId}: no non-worktree running cards`);
    return;
  }

  console.log(
    `[queue-gate] project=${projectId}: ${group.length} card(s) — ` +
      group.map((c) => `#${c.id}(qP=${c.queuePosition})`).join(', '),
  );

  const initState = await import('../init-state');
  const sm = initState.getSessionManager();
  const activeCard = group.find((c) => sm?.isActive(c.id) ?? false);

  if (activeCard) {
    const s = sm?.get(activeCard.id);
    console.log(
      `[queue-gate] project=${projectId}: card #${activeCard.id} active ` +
        `(status=${s?.status}, sid=${s?.sessionId ?? 'none'}), renumbering queue`,
    );

    if (activeCard.queuePosition != null) {
      console.log(`[queue-gate] card #${activeCard.id}: clearing queuePosition (was ${activeCard.queuePosition})`);
      activeCard.queuePosition = null;
      activeCard.updatedAt = new Date().toISOString();
      await activeCard.save();
    }

    const others = group
      .filter((c) => c.id !== activeCard.id)
      .sort((a, b) => (a.queuePosition ?? 999) - (b.queuePosition ?? 999));

    for (let i = 0; i < others.length; i++) {
      const pos = i + 1;
      if (others[i].queuePosition !== pos) {
        console.log(`[queue-gate] card #${others[i].id}: queuePosition ${others[i].queuePosition} → ${pos}`);
        others[i].queuePosition = pos;
        others[i].updatedAt = new Date().toISOString();
        await others[i].save();
      }
    }
    return;
  }

  // Nothing running — promote next card
  // Priority: card with queuePosition=null (just entered, not yet queued), then lowest queuePosition
  const unqueued = group.filter((c) => c.queuePosition == null);
  const queued = group.filter((c) => c.queuePosition != null).sort((a, b) => a.queuePosition! - b.queuePosition!);

  const toStart = unqueued[0] ?? queued[0];
  if (!toStart) return;

  console.log(
    `[queue-gate] project=${projectId}: nothing running, promoting card #${toStart.id} ` +
      `(was qP=${toStart.queuePosition})`,
  );

  if (toStart.queuePosition != null) {
    toStart.queuePosition = null;
    toStart.updatedAt = new Date().toISOString();
    await toStart.save();
  }

  const rest = group
    .filter((c) => c.id !== toStart.id)
    .sort((a, b) => (a.queuePosition ?? 999) - (b.queuePosition ?? 999));

  for (let i = 0; i < rest.length; i++) {
    const pos = i + 1;
    if (rest[i].queuePosition !== pos) {
      console.log(`[queue-gate] card #${rest[i].id}: queuePosition ${rest[i].queuePosition} → ${pos}`);
      rest[i].queuePosition = pos;
      rest[i].updatedAt = new Date().toISOString();
      await rest[i].save();
    }
  }

  if (!sm) throw new Error('SessionManager not initialized');

  console.log(`[queue-gate] project=${projectId}: launching session for card #${toStart.id}`);
  const prompt = toStart.pendingPrompt ?? toStart.description ?? '';
  toStart.pendingPrompt = null;
  toStart.pendingFiles = null;
  toStart.updatedAt = new Date().toISOString();
  await toStart.save();

  await sm.start(toStart.id, prompt, {
    provider: toStart.provider,
    model: toStart.model,
    cwd: process.cwd(),
    resume: toStart.sessionId ?? undefined,
  });

  const { registerCardSession } = await import('../controllers/oc');
  registerCardSession(toStart.id);
}
