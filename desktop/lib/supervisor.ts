// Supervises the desktop app's service processes (kpp, orcd, backend) as a
// pure Node module — no Electron imports — so it is unit-testable. Each
// service def is spawned with array args and piped stdio (never a shell, so
// paths with spaces arrive verbatim), stdout/stderr appended to
// <logDir>/<id>.log, and exited procs respawned within a rate window — more
// than MAX_RESPAWNS exits inside RESPAWN_WINDOW_MS gives up and emits 'crash'
// with the log tail. start() resolves only once healthUrl answers successfully
// (any status < 500 counts: the SPA index may 404 during development; a
// connection refusal means not ready).
import { appendFile, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn as cpSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export const MAX_RESPAWNS = 5
export const RESPAWN_WINDOW_MS = 5 * 60_000

const HEALTH_POLL_MS = 250
const HEALTH_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 5_000
const LOG_TAIL_LINES = 100

export interface ServiceDef {
  id: 'kpp' | 'orcd' | 'backend'
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

export interface Spawned extends ServiceDef {
  proc: ChildProcessWithoutNullStreams
  exited: boolean
}

export interface SupervisorOptions {
  logDir: string
  healthUrl: string
  // Path to a small file holding this instance's child PIDs (one per line).
  // The app writes it while services run and a fresh launch uses it to reap
  // orphans left by a previous instance that was hard-killed (SIGKILL/SIGTERM
  // to the electron main tears the JS down before supervisor.stop() can run —
  // Electron handles those signals at the native layer, so no JS exit handler
  // fires). Optional: omitted → no pid file, no sweep.
  pidFile?: string
  // Real seam: production runs childProcess.spawn; overriding it changes
  // environments (electron app dir vs test fixtures) and enables crash
  // simulation, which production also exercises.
  spawn?: (
    command: string,
    args: string[],
    opts: { env: Record<string, string>; cwd: string }
  ) => ChildProcessWithoutNullStreams
}

export class Supervisor {
  private readonly logDir: string
  private readonly healthUrl: string
  private readonly pidFile: string | undefined
  private readonly spawnFn: (
    command: string,
    args: string[],
    opts: { env: Record<string, string>; cwd: string }
  ) => ChildProcessWithoutNullStreams
  private readonly spawned: Spawned[] = []
  private readonly exitTimes = new Map<string, number[]>()
  private readonly givenUp = new Set<string>()
  private crashCbs: ((svc: ServiceDef, logTail: string, gaveUp: boolean) => void)[] = []
  private stopping = false

  constructor(opts: SupervisorOptions) {
    this.logDir = opts.logDir
    this.healthUrl = opts.healthUrl
    this.pidFile = opts.pidFile
    this.spawnFn = opts.spawn ?? ((c, a, o) => cpSpawn(c, a, { env: o.env, cwd: o.cwd, stdio: 'pipe' }))
    mkdirSync(this.logDir, { recursive: true })
  }

  // Reap any service children a PREVIOUS instance of this app left behind by
  // hard-killing it. Reads the pid file, SIGKILLs any PID that is still alive.
  // Called on startup, BEFORE start(), so a relaunch after a crash cleans the
  // slate. Returns the number of PIDs it signaled.
  sweepOrphans(): number {
    if (!this.pidFile) return 0
    let raw: string
    try {
      raw = readFileSync(this.pidFile, 'utf8')
    } catch {
      return 0 // no pid file → nothing to sweep
    }
    let killed = 0
    for (const line of raw.split('\n')) {
      const pid = Number(line.trim())
      if (!Number.isInteger(pid) || pid <= 0) continue
      try { process.kill(pid, 0) } catch { continue } // not alive
      try { process.kill(pid, 'SIGKILL'); killed++ } catch { /* raced away */ }
    }
    if (killed > 0) {
      try { rmSync(this.pidFile, { force: true }) } catch { /* best effort */ }
    }
    return killed
  }

  on(event: 'crash', cb: (svc: ServiceDef, logTail: string, gaveUp: boolean) => void): void {
    if (event === 'crash') this.crashCbs.push(cb)
  }

  async start(defs: ServiceDef[]): Promise<void> {
    for (const def of defs) this.spawnDef(def)
    await this.waitHealthy()
  }

  /**
   * Reset the rate window and respawn once for a service that gave up.
   * Called from the crash window's Restart button — the only place the
   * given-up state is cleared, so restart is a deliberate user action, not
   * part of the crash loop.
   */
  async restart(id: string): Promise<void> {
    if (this.stopping) return
    const def = this.spawned.find((s) => s.id === id)
    if (!def) return
    this.exitTimes.set(id, [])
    this.givenUp.delete(id)
    this.spawnDef(def)
  }

  async stop(): Promise<void> {
    this.stopping = true
    const live = this.spawned.filter((s) => !s.exited)
    for (const s of live) s.proc.kill('SIGTERM')
    // exit can fire synchronously on kill (fast stubs, SIGKILL), so poll the
    // supervisor-tracked exited flag rather than racing once() after the fact
    for (let i = 0; i < STOP_GRACE_MS / 50 && live.some((s) => !s.exited); i++) {
      await sleep(50)
    }
    this.killAll()
    this.clearPidFile()
  }

  // Synchronous SIGKILL sweep of every live child. The final escalation in
  // stop(). (An abrupt SIGTERM/SIGKILL to the electron main bypasses this —
  // JS signal/exit handlers do not run for it — which is exactly why the
  // pidFile + sweepOrphans() path exists: the NEXT launch reaps what this
  // one couldn't.)
  killAll(): void {
    for (const s of this.spawned) {
      if (!s.exited) {
        try { s.proc.kill('SIGKILL') } catch { /* already gone */ }
      }
    }
  }

  private logPath(def: ServiceDef): string {
    return join(this.logDir, `${def.id}.log`)
  }

  // Persist the live child PIDs so the next launch can sweep them if this
  // instance dies without a graceful stop(). Rewritten on every spawn so it
  // reflects the current set (respawns get new PIDs).
  private writePidFile(): void {
    if (!this.pidFile) return
    const pids = this.spawned.map((s) => s.proc.pid).filter((p): p is number => p !== undefined)
    try { writeFileSync(this.pidFile, pids.join('\n') + '\n') } catch { /* best effort */ }
  }

  // Clear the pid file on a clean stop() so a normal relaunch finds nothing.
  private clearPidFile(): void {
    if (!this.pidFile) return
    try { rmSync(this.pidFile, { force: true }) } catch { /* best effort */ }
  }

  private spawnDef(def: ServiceDef): void {
    const proc = this.spawnFn(def.command, def.args, { env: def.env, cwd: def.cwd })
    const s: Spawned = { ...def, proc, exited: false }
    this.spawned.push(s)
    if (s.proc.pid !== undefined) this.writePidFile()
    // append both streams to the log and drain them so pipes never backpressure
    for (const stream of [proc.stdout, proc.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        appendFile(this.logPath(def), chunk, () => {})
      })
      stream.resume() // drain: never let a pipe backpressure the child
    }
    proc.on('exit', () => {
      s.exited = true
      if (this.stopping) return
      this.handleExit(def)
    })
  }

  private handleExit(def: ServiceDef): void {
    if (this.givenUp.has(def.id)) return // already reported; don't re-crash-loop
    const now = Date.now()
    const times = (this.exitTimes.get(def.id) ?? []).filter((t) => now - t < RESPAWN_WINDOW_MS)
    times.push(now)
    this.exitTimes.set(def.id, times)
    if (times.length > MAX_RESPAWNS) {
      this.givenUp.add(def.id)
      for (const cb of this.crashCbs) cb(def, logTail(this.logPath(def)), true)
      return
    }
    this.spawnDef(def)
  }

  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    for (;;) {
      if (await probe(this.healthUrl)) return
      if (Date.now() >= deadline) {
        throw new Error(
          `health url ${this.healthUrl} not ready after ${HEALTH_TIMEOUT_MS} ms\n\nbackend log tail:\n${logTail(join(this.logDir, 'backend.log'))}`
        )
      }
      await sleep(HEALTH_POLL_MS)
    }
  }
}

async function probe(url: string): Promise<boolean> {
  try {
    // any status < 500 counts as ready — a 404 index is fine, 5xx/refusal is not
    const res = await fetch(url)
    return res.status < 500
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function logTail(path: string): string {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-LOG_TAIL_LINES).join('\n')
  } catch {
    return ''
  }
}
