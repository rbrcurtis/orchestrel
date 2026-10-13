// Supervises the desktop app's service processes (kpp, orcd, backend) as a
// pure Node module — no Electron imports — so it is unit-testable. Each
// service def is spawned with array args and piped stdio (never a shell, so
// paths with spaces arrive verbatim), stdout/stderr appended to
// <logDir>/<id>.log, and exited procs respawned within a rate window — more
// than MAX_RESPAWNS exits inside RESPAWN_WINDOW_MS gives up and emits 'crash'
// with the log tail. start() resolves only once healthUrl answers successfully
// (any status < 500 counts: the SPA index may 404 during development; a
// connection refusal means not ready).
import { appendFile, mkdirSync, readFileSync } from 'node:fs'
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
    this.spawnFn = opts.spawn ?? ((c, a, o) => cpSpawn(c, a, { env: o.env, cwd: o.cwd, stdio: 'pipe' }))
    mkdirSync(this.logDir, { recursive: true })
  }

  on(event: 'crash', cb: (svc: ServiceDef, logTail: string, gaveUp: boolean) => void): void {
    if (event === 'crash') this.crashCbs.push(cb)
  }

  async start(defs: ServiceDef[]): Promise<void> {
    for (const def of defs) this.spawnDef(def)
    await this.waitHealthy()
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
    for (const s of live) {
      if (!s.exited) s.proc.kill('SIGKILL')
    }
  }

  private logPath(def: ServiceDef): string {
    return join(this.logDir, `${def.id}.log`)
  }

  private spawnDef(def: ServiceDef): void {
    const proc = this.spawnFn(def.command, def.args, { env: def.env, cwd: def.cwd })
    const s: Spawned = { ...def, proc, exited: false }
    this.spawned.push(s)
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
