/* The maintainer calendar lives in orcd because orcd owns every timer. The backend
 * used to run these jobs in-process (startMemoryMaintainer / startPreferenceMaintainer,
 * called from src/server/init.ts and the dev ws/server.ts), which put the agent SDK's
 * heaviest import on the web boot path and let the prod and dev backends both run the
 * same job against one database.
 *
 * Exactly one node runs them: the one whose orcd.yaml sets `maintainers: true`, which is
 * the box that owns orchestrel.db. Each job is a self-rescheduling setTimeout on
 * wall-clock time, one run in flight at a time, and a missed fire — a restart across the
 * fire time, say — waits for that job's next slot. */
import { runMaintain } from '../lib/memory-maintainer/maintain';
import { runMerge } from '../lib/memory-maintainer/merge';
import { runPreferences } from '../lib/preference-maintainer/maintain';
import { loadConfig } from '../shared/config';

const DAILY_HOUR = 3;
const PREFERENCES_HOUR = 4;
const WEEKLY_HOUR = 3;
const WEEKLY_DAY = 0; // Sunday
const MAX_TIMEOUT = 2_147_483_647;

let started = false;
const timers: ReturnType<typeof setTimeout>[] = [];
const inFlight = new Set<string>();

export function startMaintainerScheduler(): () => void {
  if (started) {
    console.log('[orcd] maintainer timers already started');
  } else {
    started = true;
    schedule('memory-daily', runMemoryDaily, () => msUntil(DAILY_HOUR, 0));
    schedule('memory-weekly', runMemoryWeekly, () => msUntil(WEEKLY_HOUR, 0, WEEKLY_DAY));
    schedule('preferences-daily', runPreferencesDaily, () => msUntil(PREFERENCES_HOUR, 0));
  }
  return stopMaintainerScheduler;
}

export function stopMaintainerScheduler(): void {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
  inFlight.clear();
  started = false;
}

/** Milliseconds until the next fire at hour:minute, optionally only on dayOfWeek. */
export function msUntil(hour: number, minute: number, dayOfWeek?: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  if (dayOfWeek !== undefined) {
    while (next.getDay() !== dayOfWeek) next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

async function runMemoryDaily(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.memory) {
    const start = Date.now();
    const summary = await runMaintain(cfg);
    console.log(
      `[memory-maintainer] daily run done in ${Date.now() - start}ms`,
      summary ? `${summary.projects.length} projects` : 'disabled',
    );
  } else {
    console.log('[memory-maintainer] daily run skipped: this config has no memory section');
  }
}

async function runMemoryWeekly(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.memory) {
    const start = Date.now();
    const summary = await runMerge(cfg);
    console.log(
      `[memory-maintainer] weekly merge done in ${Date.now() - start}ms`,
      summary ? `${summary.groups} groups` : 'disabled',
    );
  } else {
    console.log('[memory-maintainer] weekly merge skipped: this config has no memory section');
  }
}

async function runPreferencesDaily(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.memory?.preferences) {
    const start = Date.now();
    const summary = await runPreferences(cfg);
    console.log(
      `[preference-maintainer] daily run done in ${Date.now() - start}ms`,
      summary ? `${summary.users.length} user(s)` : 'disabled',
    );
  } else {
    console.log('[preference-maintainer] daily run skipped: this config has no memory.preferences section');
  }
}

function schedule(name: string, job: () => Promise<void>, nextMs: () => number): void {
  const t = setTimeout(
    () => {
      void fire(name, job);
      // Re-arm on the job's own cadence: the closure carries the daily or weekly
      // computation, so each timer stays on its own schedule after the first fire.
      schedule(name, job, nextMs);
    },
    Math.min(nextMs(), MAX_TIMEOUT),
  );
  timers.push(t);
}

async function fire(name: string, job: () => Promise<void>): Promise<void> {
  if (inFlight.has(name)) {
    console.log(`[orcd] maintainer ${name} is still running; skipping this fire`);
  } else {
    inFlight.add(name);
    try {
      await job();
    } catch (err) {
      console.error(`[orcd] maintainer ${name} failed:`, err);
    } finally {
      inFlight.delete(name);
    }
  }
}
