/* In-process daily timer for the preference maintainer, started once by the
 * server init paths (production init.ts and dev ws/server.ts guarded block),
 * mirroring the knowledge maintainer. Runs at midnight, offset from the 02:00
 * knowledge run. One run in flight at a time; a missed fire waits one day. */
import { loadConfig } from '../../shared/config';
import { msUntil } from '../memory-maintainer/scheduler';
import { runPreferences } from './maintain';

const DAILY_HOUR = 0;

let started = false;
let running = false;
const timers: ReturnType<typeof setTimeout>[] = [];

export function startPreferenceMaintainer(): () => void {
  if (started) return () => stopTimers();
  started = true;
  schedule(
    () => void fire(),
    () => msUntil(DAILY_HOUR, 0),
  );
  return () => stopTimers();
}

async function fire(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const cfg = loadConfig();
    if (!cfg.memory?.preferences) return;
    const start = Date.now();
    const summary = await runPreferences(cfg);
    console.log(
      `[preference-maintainer] daily run done in ${Date.now() - start}ms`,
      summary ? `${summary.users.length} user(s)` : 'disabled',
    );
  } catch (err) {
    console.error('[preference-maintainer] run failed:', err);
  } finally {
    running = false;
  }
}

function schedule(fn: () => void, nextMs: () => number): void {
  const max = 2_147_483_647;
  const t = setTimeout(
    () => {
      fn();
      schedule(fn, nextMs);
    },
    Math.min(nextMs(), max),
  );
  timers.push(t);
}

function stopTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
  started = false;
}
