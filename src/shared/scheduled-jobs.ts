import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Pi's pi-subagents extension persists scheduled subagents per session at
// <cwd>/.pi/subagent-schedules/<sessionId>.json. A job with enabled:true is
// armed and waiting to fire; a fired (or missed) "once" job flips to
// enabled:false. orcd treats "has an enabled scheduled job" as pending work so
// the session stays alive — and the card stays parked — until the job fires,
// mirroring how a run_in_background async task delays session_exit.
//
// We scan the whole directory rather than keying on a single sessionId because
// Pi forks the session id on resume; any enabled job in the worktree belongs to
// this card's session lineage.
export function hasEnabledScheduledJobs(cwd: string): boolean {
  const dir = join(cwd, '.pi', 'subagent-schedules');
  if (!existsSync(dir)) return false;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(dir, name), 'utf-8');
        const data = JSON.parse(raw) as { jobs?: Array<{ enabled?: boolean }> };
        if (data.jobs?.some((j) => j.enabled === true)) return true;
      } catch {
        // corrupt/partial file mid-write — ignore, next poll re-reads
      }
    }
  } catch {
    // dir vanished (worktree cleanup raced us) — nothing pending
  }
  return false;
}
