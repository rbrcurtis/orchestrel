// Main-process line logger. Kept out of main.ts so modules that need it
// (updater) can import without dragging main.ts's module-scope electron boot
// code into vitest collection.
import { app } from 'electron'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

export function logLine(svc: string, ...parts: unknown[]): Promise<void> {
  try {
    return appendFile(join(app.getPath('userData'), 'logs', 'main.log'), `${new Date().toISOString()} [${svc}] ${parts.join(' ')}\n`)
  } catch {
    // logging must never take the app down
  }
  return Promise.reject(new Error('logging unavailable'))
}
