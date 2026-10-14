// Main-process line logger. Kept out of main.ts so modules that need it
// (updater) can import without dragging main.ts's module-scope electron boot
// code into vitest collection. Lines go to <userData>/logs/main.log; when the
// file grows past MAX_LOG_BYTES it rolls to main.log.1 (previous .1 dropped),
// so logs stay "rotating" per the spec and bounded on a machine left running.
// logLine never rejects: every caller uses `void logLine(...)`, and a failed
// log write must be a swallowed error, not an unhandled rejection.
import { app } from 'electron'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const MAX_LOG_BYTES = 5 * 1024 * 1024
const ROTATED_SUFFIX = '.1'

export async function logLine(svc: string, ...parts: unknown[]): Promise<void> {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'main.log')
    try {
      const st = await stat(file)
      if (st.size > MAX_LOG_BYTES) await rename(file, join(dir, `main.log${ROTATED_SUFFIX}`))
    } catch {
      // no file yet (or vanished between stat and append) — nothing to roll
    }
    await appendFile(file, `${new Date().toISOString()} [${svc}] ${parts.join(' ')}\n`)
  } catch {
    // logging must never take the app down
  }
}
