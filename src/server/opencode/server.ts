import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { resolve } from 'path'

const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4097)
const CONFIG_PATH = resolve('data/opencode.json')
const MAX_RETRIES = 5
const HEALTH_POLL_MS = 500
const HEALTH_TIMEOUT_MS = 30_000

export class OpenCodeServer {
  private proc: ChildProcess | null = null
  private retries = 0
  private backoffMs = 1000
  private stopping = false
  client: ReturnType<typeof createOpencodeClient> | null = null

  /** Optional callback — set by ws/server.ts to notify clients on crash */
  onCrash?: () => void

  async start(): Promise<void> {
    try {
      execFileSync('which', ['opencode'], { stdio: 'ignore' })
    } catch {
      throw new Error('opencode binary not found on PATH. Install it before starting Dispatcher.')
    }

    await this.spawn()
    this.client = createOpencodeClient({ baseUrl: `http://localhost:${OPENCODE_PORT}` })
    await this.waitForHealthy()
    console.log(`[opencode] server ready on port ${OPENCODE_PORT}`)
  }

  private spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn('opencode', ['serve'], {
        env: {
          ...process.env,
          OPENCODE_PORT: String(OPENCODE_PORT),
          OPENCODE_CONFIG: CONFIG_PATH,
        },
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
        const sdk = this.client as any
        const sessions = await sdk.session.list()
        const list = sessions.data ?? sessions ?? []
        for (const s of list) {
          if (s.status === 'active' || s.status === 'running') {
            await sdk.session.abort({ path: { id: s.id } }).catch(() => {})
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
