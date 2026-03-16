import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { resolve as resolvePath } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4097)
const MAX_RETRIES = 5

/** Resolve opencode binary — check common install locations if not on PATH */
function findOpencodeBinary(): string {
  // Check PATH first
  try {
    return execFileSync('which', ['opencode'], { encoding: 'utf-8' }).trim()
  } catch {
    // Not on PATH
  }
  // Check common install locations
  const candidates = [
    join(homedir(), '.opencode', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error('opencode binary not found. Install it: curl -fsSL https://opencode.ai/install | bash')
}
const HEALTH_POLL_MS = 500
const HEALTH_TIMEOUT_MS = 60_000

export class OpenCodeServer {
  private proc: ChildProcess | null = null
  private retries = 0
  private backoffMs = 1000
  private stopping = false
  client: ReturnType<typeof createOpencodeClient> | null = null

  /** Optional callback — set by ws/server.ts to notify clients on crash */
  onCrash?: () => void

  private binaryPath = ''

  async start(): Promise<void> {
    this.binaryPath = findOpencodeBinary()
    console.log(`[opencode] using binary: ${this.binaryPath}`)

    // Check if OpenCode is already running (survives Vite HMR restarts)
    const client = createOpencodeClient({ baseUrl: `http://localhost:${OPENCODE_PORT}` })
    try {
      const res = await fetch(`http://localhost:${OPENCODE_PORT}/api/health`)
      if (res.ok) {
        console.log(`[opencode] already running on port ${OPENCODE_PORT}, reusing`)
        this.client = client
        return
      }
    } catch {
      // Not running, spawn it
    }

    await this.spawn()
    this.client = client
    await this.waitForHealthy()
    console.log(`[opencode] server ready on port ${OPENCODE_PORT}`)
  }

  private spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.binaryPath, ['serve', '--port', String(OPENCODE_PORT)], {
        env: {
          ...process.env,
          KIROCLI_DB_PATH_OKKANTI: join(homedir(), 'OK_HOME', '.local', 'share', 'kiro-cli', 'data.sqlite3'),
          KIROCLI_DB_PATH_TRACKABLE: join(homedir(), '.local', 'share', 'kiro-cli', 'data.sqlite3'),
        },
        cwd: resolvePath('.'),
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      this.proc.stdout?.on('data', (d: Buffer) => console.log(`[opencode] ${d.toString().trim()}`))
      this.proc.stderr?.on('data', (d: Buffer) => console.error(`[opencode] ${d.toString().trim()}`))

      this.proc.on('error', (err) => {
        console.error('[opencode] spawn error:', err)
        reject(err)
      })

      this.proc.on('exit', (code) => {
        console.log(`[opencode] process exited with code ${code}`)
        if (!this.stopping) this.handleCrash()
      })

      resolve()
    })
  }

  private async waitForHealthy(): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < HEALTH_TIMEOUT_MS) {
      try {
        const res = await fetch(`http://localhost:${OPENCODE_PORT}/api/health`)
        if (res.ok) return
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
    }
    throw new Error(`[opencode] server did not become healthy within ${HEALTH_TIMEOUT_MS}ms`)
  }

  private async handleCrash(): Promise<void> {
    this.onCrash?.()
    if (this.retries >= MAX_RETRIES) {
      console.error(`[opencode] max retries (${MAX_RETRIES}) exhausted, server unavailable`)
      return
    }
    this.retries++
    console.log(`[opencode] restarting (attempt ${this.retries}/${MAX_RETRIES}, backoff ${this.backoffMs}ms)`)
    await new Promise((r) => setTimeout(r, this.backoffMs))
    this.backoffMs = Math.min(this.backoffMs * 2, 8000)
    try {
      await this.spawn()
      await this.waitForHealthy()
      this.retries = 0
      this.backoffMs = 1000
      console.log('[opencode] server recovered')
    } catch (err) {
      console.error('[opencode] restart failed:', err)
      this.handleCrash()
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.client) {
      try {
        interface SdkSession { id: string; status: string }
        interface SdkClient {
          session: {
            list(): Promise<{ data?: SdkSession[] } | SdkSession[]>
            abort(opts: { sessionID: string }): Promise<void>
          }
        }
        const sdk = this.client as unknown as SdkClient
        const sessions = await sdk.session.list()
        const list: SdkSession[] = (sessions as { data?: SdkSession[] }).data ?? (sessions as SdkSession[]) ?? []
        for (const s of list) {
          if (s.status === 'active' || s.status === 'running') {
            await sdk.session.abort({ sessionID: s.id }).catch(() => {})
          }
        }
      } catch {
        // Best effort
      }
    }
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
    this.client = null
  }
}

export const openCodeServer = new OpenCodeServer()
