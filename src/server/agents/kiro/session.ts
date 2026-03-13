import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { AgentSession } from '../types'
import type { SessionStatus, AgentMessage } from '../types'
import { normalizeKiroMessage } from './messages'

export class KiroSession extends AgentSession {
  sessionId: string | null = null
  status: SessionStatus = 'starting'
  promptsSent = 0
  turnsCompleted = 0

  /** When true, emit messages from stdio. Set to false when tailer is active (Stage 3). */
  emitFromStdio = true
  /** Suppress notifications during session/load (replay of prior conversation). */
  private loading = false
  private proc: ChildProcess | null = null
  private buffer = ''
  private rpcId = 0

  constructor(
    private readonly cwd: string,
    private readonly agentProfile: string,
    private readonly resumeSessionId?: string,
  ) {
    super()
  }

  async start(prompt: string): Promise<void> {
    this.proc = spawn('kiro-cli', ['acp'], {
      cwd: this.cwd,
      env: { ...process.env, HOME: this.agentProfile },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      this.processBuffer()
    })

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      console.error(`[kiro:stderr] ${chunk.toString().trim()}`)
    })

    this.proc.on('exit', (code) => {
      console.log(`[kiro] process exited code=${code}`)
      // Reject any pending RPCs — process died before responding
      for (const [, { reject }] of this.pendingRpc) {
        reject(new Error(`Kiro process exited (code=${code}) with pending RPCs`))
      }
      this.pendingRpc.clear()
      if (this.status === 'running' || this.status === 'starting') {
        this.status = code === 0 ? 'completed' : 'errored'
      }
      this.emit('exit')
    })

    // Initialize — ACP requires protocolVersion and clientInfo
    const initResult = await this.rpc('initialize', {
      protocolVersion: '1.0',
      clientInfo: { name: 'dispatcher', version: '1.0.0' },
    })
    console.log('[kiro] initialized:', JSON.stringify(initResult))

    // Create or load session
    if (this.resumeSessionId) {
      this.loading = true
      const loadResult = await this.rpc('session/load', {
        sessionId: this.resumeSessionId,
        cwd: this.cwd,
        mcpServers: [],
      })
      this.loading = false
      this.sessionId = this.resumeSessionId
      console.log('[kiro] session loaded:', JSON.stringify(loadResult))
    } else {
      const newResult = await this.rpc('session/new', {
        cwd: this.cwd,
        mcpServers: [],
      }) as Record<string, unknown>
      this.sessionId = (newResult.sessionId ?? newResult.session_id ?? newResult.id ?? null) as string | null
      console.log(`[kiro] new session created, id=${this.sessionId}`)
    }

    this.status = 'running'

    // Send first prompt — don't await; the RPC resolves when the turn ends.
    // Streaming notifications arrive via processBuffer() in the meantime.
    this.sendPrompt(prompt)
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.proc || this.proc.killed) throw new Error('Kiro process not running')
    this.promptsSent++
    this.sendPrompt(content)
  }

  /** Fire prompt RPC and emit turn_end when it resolves. */
  private sendPrompt(text: string): void {
    this.rpc('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }).then(() => {
      this.turnsCompleted++
      const turnEnd: AgentMessage = {
        type: 'turn_end',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      }
      if (this.emitFromStdio) {
        this.emit('message', turnEnd)
      }
    }).catch((err) => {
      console.error('[kiro] prompt RPC failed:', err)
    })
  }

  async kill(): Promise<void> {
    if (!this.proc || this.proc.killed) {
      this.status = 'stopped'
      return
    }
    try {
      this.rpcFire('session/cancel', { sessionId: this.sessionId })
    } catch { /* ignore EPIPE */ }
    this.status = 'stopped'
    // Kill the entire process group (kiro-cli spawns child processes)
    const pid = this.proc.pid
    if (pid) {
      try { process.kill(-pid, 'SIGTERM') } catch { /* ignore */ }
    }
    this.proc = null
  }

  async waitForReady(): Promise<void> {
    // sessionId is set synchronously during start() after the session/new RPC resolves.
    // Since start() is awaited before waitForReady() is called (see begin-session.ts),
    // sessionId is always available by this point.
    if (this.sessionId) return
    throw new Error('Kiro session failed to initialize — no sessionId after start()')
  }

  // ── JSON-RPC transport ────────────────────────────────────────────────────

  private pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.rpcId
      this.pendingRpc.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Fire-and-forget RPC (no response expected) */
  private rpcFire(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) return
    const json = JSON.stringify(msg)
    this.proc.stdin.write(json + '\n')
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as Record<string, unknown>
        this.handleRpcMessage(msg)
      } catch {
        console.error('[kiro] failed to parse:', line.slice(0, 200))
      }
    }
  }

  private handleRpcMessage(msg: Record<string, unknown>): void {
    // JSON-RPC response (has id)
    if ('id' in msg && typeof msg.id === 'number') {
      const pending = this.pendingRpc.get(msg.id)
      if (pending) {
        this.pendingRpc.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // JSON-RPC notification (no id) — these are session events
    // In Stage 2 (before tailer), emit messages from stdio.
    // In Stage 3, the tailer becomes the sole event source and
    // this.emitFromStdio is set to false by begin-session.ts.
    if ('method' in msg && (msg.method === 'session/update' || msg.method === 'session/notification')) {
      const params = msg.params as Record<string, unknown> | undefined
      if (!params) return
      const agentMsg = normalizeKiroMessage(params)
      if (agentMsg && this.emitFromStdio && !this.loading) {
        this.emit('message', agentMsg)
      }
      return
    }

    // Log unrecognized messages
    console.debug('[kiro] unrecognized message:', JSON.stringify(msg).slice(0, 200))
  }
}
