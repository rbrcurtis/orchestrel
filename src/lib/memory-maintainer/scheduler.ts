/* In-process daily + weekly timers for the memory maintainer, started once by
 * the server init paths (production init.ts and dev ws/server.ts guarded
 * block). One run in flight at a time; a missed fire just waits for the next
 * scheduled slot. */
import { loadConfig } from '../../shared/config';
import { runMaintain } from './maintain';
import { runMerge } from './merge';

const DAILY_HOUR = 2;
const WEEKLY_HOUR = 3;
const WEEKLY_DAY = 0; // Sunday

let started = false;
let running = false;
const timers: ReturnType<typeof setTimeout>[] = [];

export function startMemoryMaintainer(): () => void {
  if (started) return () => stopTimers();
  started = true;
  schedule(() => void fire('daily'), () => msUntil(DAILY_HOUR, 0));
  schedule(() => void fire('weekly'), () => msUntil(WEEKLY_HOUR, 0, WEEKLY_DAY));
  return () => stopTimers();
}

async function fire(kind: 'daily' | 'weekly'): Promise<void> {
  if (running) return;
  running = true;
  try {
    const cfg = loadConfig();
    if (!cfg.memory) return;
    const start = Date.now();
    if (kind === 'daily') {
      const summary = await runMaintain(cfg);
      console.log(`[memory-maintainer] daily run done in ${Date.now() - start}ms`, summary ? `${summary.projects.length} projects` : 'disabled');
    } else {
      const summary = await runMerge(cfg);
      console.log(`[memory-maintainer] weekly merge done in ${Date.now() - start}ms`, summary ? `${summary.groups} groups` : 'disabled');
    }
  } catch (err) {
    console.error('[memory-maintainer] run failed:', err);
  } finally {
    running = false;
  }
}

function schedule(fn: () => void, nextMs: () => number): void {
  const max = 2_147_483_647;
  const t = setTimeout(() => {
    fn();
    // Re-arm with the kind's own cadence: the closure captures the daily
    // 02:00 or weekly Sunday 03:00 computation, so each timer stays on its
    // own schedule after the first fire.
    schedule(fn, nextMs);
  }, Math.min(nextMs(), max));
  timers.push(t);
}

function stopTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
}

/** Milliseconds until the next fire. Exported for tests. */
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
