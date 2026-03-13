# OpenCode Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Claude SDK and Kiro ACP agent providers with a single OpenCode backend.

**Architecture:** Dispatcher spawns `opencode serve` as a child process, connects via `@opencode-ai/sdk`, and routes all agent sessions through OpenCode's REST/SSE API. One `OpenCodeSession` class replaces both `ClaudeSession` and `KiroSession`.

**Tech Stack:** `@opencode-ai/sdk`, OpenCode CLI (`opencode serve`), SSE for streaming, SQLite (Drizzle ORM)

**Spec:** `docs/superpowers/specs/2026-03-13-opencode-migration-design.md`

---

## Chunk 1: Foundation — OpenCode Server & Session Type

### Task 1: Install OpenCode SDK and remove old SDK

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install @opencode-ai/sdk**

Run: `pnpm add @opencode-ai/sdk`

- [ ] **Step 2: Remove @anthropic-ai/claude-agent-sdk**

Run: `pnpm remove @anthropic-ai/claude-agent-sdk`

- [ ] **Step 3: Verify install**

Run: `pnpm ls @opencode-ai/sdk`
Expected: Package listed with version

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "deps: replace claude-agent-sdk with opencode-sdk"
```

### Task 2: Create OpenCode server manager

**Files:**
- Create: `src/server/opencode/server.ts`

This module spawns `opencode serve` as a child process, monitors it, and exposes the SDK client.

- [ ] **Step 1: Create the OpenCodeServer class**

```typescript
// src/server/opencode/server.ts
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

  async start(): Promise<void> {
    // Verify binary exists
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

      // Resolve immediately — health check confirms readiness
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

  /** Optional callback — set by ws/server.ts to notify clients on crash */
  onCrash?: () => void

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
    // Abort all active sessions before killing
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
        // Best effort — server may already be dying
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
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: No errors (or only pre-existing errors unrelated to this file)

- [ ] **Step 3: Commit**

```bash
git add src/server/opencode/server.ts
git commit -m "feat: add OpenCode server lifecycle manager"
```

### Task 3: Update AgentSession types

**Files:**
- Modify: `src/server/agents/types.ts`

- [ ] **Step 1: Update AgentType and remove queryStartIndex**

In `src/server/agents/types.ts`:
- Change `AgentType` from `'claude' | 'kiro'` to `'opencode'`
- Remove `queryStartIndex = 0` from `AgentSession`
- Remove `model?: string` and `thinkingLevel?: string` from `AgentSession` (now handled by `OpenCodeSession.updateModel()`)

```typescript
export type AgentType = 'opencode'
```

Remove these lines from `AgentSession`:
```typescript
  model?: string
  thinkingLevel?: string
  queryStartIndex = 0
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: Errors in files that reference old types (claude/session.ts, kiro/session.ts, etc.) — this is expected, they'll be deleted in a later task.

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/types.ts
git commit -m "refactor: update AgentType to 'opencode', remove queryStartIndex"
```

### Task 4: Create model mapping helper

**Files:**
- Create: `src/server/agents/opencode/models.ts`

- [ ] **Step 1: Create the model resolver**

```typescript
// src/server/agents/opencode/models.ts

type Model = 'sonnet' | 'opus'
type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

const MODEL_MAP: Record<Model, Record<ThinkingLevel, string>> = {
  sonnet: {
    off: 'claude-sonnet-4-6',
    low: 'claude-sonnet-4-6-thinking',
    medium: 'claude-sonnet-4-6-thinking',
    high: 'claude-sonnet-4-6-thinking',
  },
  opus: {
    off: 'claude-opus-4-6',
    low: 'claude-opus-4-6-thinking',
    medium: 'claude-opus-4-6-thinking',
    high: 'claude-opus-4-6-thinking',
  },
}

export function resolveModelID(
  model: Model = 'sonnet',
  thinkingLevel: ThinkingLevel = 'high',
): string {
  return MODEL_MAP[model]?.[thinkingLevel] ?? MODEL_MAP.sonnet.high
}
```

Note: The actual thinking budget differentiation between low/medium/high is configured in `data/opencode.json` model variants. The model ID is the same for all thinking levels — the variant config controls the token budget.

- [ ] **Step 2: Commit**

```bash
git add src/server/agents/opencode/models.ts
git commit -m "feat: add OpenCode model ID resolver"
```

### Task 5: Create event normalization

**Files:**
- Create: `src/server/agents/opencode/messages.ts`

- [ ] **Step 1: Create the normalizer**

```typescript
// src/server/agents/opencode/messages.ts
import type { AgentMessage } from '../types'

/**
 * Normalize an OpenCode SSE event into an AgentMessage.
 * The exact event shape will need refinement during integration testing
 * once we can observe real SSE output from `opencode serve`.
 */
export function normalizeOpenCodeEvent(event: {
  type: string
  properties: Record<string, unknown>
}): AgentMessage | null {
  const ts = Date.now()

  switch (event.type) {
    case 'message.part': {
      const part = event.properties as {
        type: string
        content?: string
        toolInvocation?: {
          toolCallId: string
          toolName: string
          args: Record<string, unknown>
          state: string
          result?: string
        }
      }

      if (part.type === 'text' || part.type === 'text-delta') {
        return {
          type: 'text',
          role: 'assistant',
          content: (part.content as string) ?? '',
          timestamp: ts,
        }
      }

      if (part.type === 'thinking' || part.type === 'reasoning') {
        return {
          type: 'thinking',
          role: 'assistant',
          content: (part.content as string) ?? '',
          timestamp: ts,
        }
      }

      if (part.type === 'tool-invocation' && part.toolInvocation) {
        const inv = part.toolInvocation
        if (inv.state === 'call' || inv.state === 'partial-call') {
          return {
            type: 'tool_call',
            role: 'assistant',
            content: '',
            toolCall: {
              id: inv.toolCallId,
              name: inv.toolName,
              params: inv.args,
            },
            timestamp: ts,
          }
        }
        if (inv.state === 'result') {
          return {
            type: 'tool_result',
            role: 'assistant',
            content: typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result),
            toolResult: {
              id: inv.toolCallId,
              output: typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result),
              isError: false,
            },
            timestamp: ts,
          }
        }
      }

      return null
    }

    case 'message.created': {
      const msg = event.properties as { role?: string; content?: string }
      if (msg.role === 'user') {
        return {
          type: 'user',
          role: 'user',
          content: (msg.content as string) ?? '',
          timestamp: ts,
        }
      }
      return null
    }

    case 'session.error': {
      return {
        type: 'error',
        role: 'system',
        content: (event.properties.message as string) ?? 'Unknown error',
        timestamp: ts,
      }
    }

    default:
      return null
  }
}
```

Note: This normalizer is a best-effort mapping based on OpenCode's documented event types. It will need refinement during integration testing with a live `opencode serve` instance. The key contract is: output must conform to `AgentMessage`.

- [ ] **Step 2: Commit**

```bash
git add src/server/agents/opencode/messages.ts
git commit -m "feat: add OpenCode SSE event normalizer"
```

### Task 6: Create OpenCodeSession

**Files:**
- Create: `src/server/agents/opencode/session.ts`

- [ ] **Step 1: Create the session class**

```typescript
// src/server/agents/opencode/session.ts
import { AgentSession } from '../types'
import type { SessionStatus, AgentMessage } from '../types'
import { normalizeOpenCodeEvent } from './messages'
import { resolveModelID } from './models'

export class OpenCodeSession extends AgentSession {
  sessionId: string | null = null
  status: SessionStatus = 'starting'
  promptsSent = 0
  turnsCompleted = 0

  private abortController: AbortController | null = null
  private sseCleanup: (() => void) | null = null

  constructor(
    private client: unknown, // SDK client type — will refine when SDK types are available
    private cwd: string,
    private providerID: string,
    private modelID: string,
    private resumeSessionId?: string,
  ) {
    super()
    if (resumeSessionId) {
      this.sessionId = resumeSessionId
    }
  }

  async start(prompt: string): Promise<void> {
    this.status = 'running'
    const sdk = this.client as any // SDK type refinement during integration

    if (!this.sessionId) {
      // Create new session
      const res = await sdk.session.create({
        body: { title: prompt.slice(0, 100) },
        query: { directory: this.cwd },
      })
      this.sessionId = res.data?.id ?? res.id
    }

    // Subscribe to SSE events before sending prompt
    this.subscribeToEvents()

    // Send the prompt
    this.promptsSent++
    await sdk.session.prompt({
      path: { id: this.sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        model: { providerID: this.providerID, modelID: this.modelID },
      },
      query: { directory: this.cwd },
    })
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.sessionId) throw new Error('No active session')
    const sdk = this.client as any

    this.promptsSent++
    this.status = 'running'

    await sdk.session.prompt({
      path: { id: this.sessionId },
      body: {
        parts: [{ type: 'text', text: content }],
        model: { providerID: this.providerID, modelID: this.modelID },
      },
      query: { directory: this.cwd },
    })
  }

  /** Update model for next sendMessage call (mid-session model switch) */
  updateModel(model: string, thinkingLevel: string): void {
    this.modelID = resolveModelID(
      model as 'sonnet' | 'opus',
      thinkingLevel as 'off' | 'low' | 'medium' | 'high',
    )
  }

  async kill(): Promise<void> {
    if (!this.sessionId) return
    const sdk = this.client as any

    try {
      await sdk.session.abort({ path: { id: this.sessionId } })
    } catch (err) {
      console.error(`[opencode-session:${this.sessionId}] abort error:`, err)
    }

    this.sseCleanup?.()
    this.abortController?.abort()
    this.status = 'stopped'
    this.emit('exit')
  }

  async waitForReady(): Promise<void> {
    // For resumed sessions, sessionId is already set
    if (this.sessionId) return

    // For new sessions, start() sets sessionId synchronously before returning
    // If somehow not set, wait briefly
    const start = Date.now()
    while (!this.sessionId && Date.now() - start < 30_000) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!this.sessionId) throw new Error('Session did not become ready within 30s')
  }

  private subscribeToEvents(): void {
    const sdk = this.client as any
    this.abortController = new AbortController()

    const subscribe = async () => {
      try {
        const events = await sdk.event.subscribe({
          signal: this.abortController!.signal,
        })

        for await (const event of events.stream) {
          if (this.abortController?.signal.aborted) break

          // Filter to events for this session
          const sessionId = (event.properties as any)?.sessionId ?? (event.properties as any)?.session_id
          if (sessionId && sessionId !== this.sessionId) continue

          const msg = normalizeOpenCodeEvent(event)
          if (msg) this.emit('message', msg)

          // Detect turn completion
          if (event.type === 'message.completed') {
            const role = (event.properties as any)?.role
            if (role === 'assistant') {
              this.turnsCompleted++
              this.emit('message', {
                type: 'turn_end',
                role: 'system',
                content: '',
                timestamp: Date.now(),
              } satisfies AgentMessage)
            }
          }

          // Detect session end
          if (event.type === 'session.completed' || event.type === 'session.error') {
            this.status = event.type === 'session.error' ? 'errored' : 'completed'
            this.emit('exit')
            break
          }
        }
      } catch (err) {
        if (this.abortController?.signal.aborted) return
        console.error(`[opencode-session:${this.sessionId}] SSE error:`, err)
        this.status = 'errored'
        this.emit('message', {
          type: 'error',
          role: 'system',
          content: `SSE stream error: ${err}`,
          timestamp: Date.now(),
        } satisfies AgentMessage)
        this.emit('exit')
      }
    }

    subscribe()
    this.sseCleanup = () => this.abortController?.abort()
  }
}
```

Note: The SDK client type is `any`-cast for now. Once we can run against a live OpenCode server, we'll refine the types based on what the SDK actually exports. The event type names (`message.part`, `message.completed`, `session.completed`) are based on OpenCode's documentation and will need verification.

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: Errors only in old files (claude/, kiro/) that still reference removed types — those are deleted next.

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/opencode/session.ts
git commit -m "feat: add OpenCodeSession agent implementation"
```

## Chunk 2: Schema & Wiring

### Task 7: Update DB schema

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/shared/ws-protocol.ts`

This must happen before rewriting factory/begin-session, since those files reference `project.providerID`.

- [ ] **Step 1: Replace agentType/agentProfile with providerID**

In `src/server/db/schema.ts`, find the projects table definition and:
- Replace `agentType: text('agent_type', { enum: ['claude', 'kiro'] }).notNull().default('claude')` with `providerID: text('provider_id').notNull().default('anthropic')`
- Remove `agentProfile: text('agent_profile')`

- [ ] **Step 2: Update ws-protocol.ts**

In `src/shared/ws-protocol.ts`, update `projectCreateSchema`:
- Change `agentType: true, agentProfile: true,` to `providerID: true,`

The `projectUpdateSchema` derives from `projectCreateSchema.partial()` so it updates automatically.

- [ ] **Step 3: Commit**

```bash
git add src/server/db/schema.ts src/shared/ws-protocol.ts
git commit -m "schema: replace agentType/agentProfile with providerID"
```

### Task 8: Update factory and session opts

**Files:**
- Modify: `src/server/agents/factory.ts`

- [ ] **Step 1: Rewrite factory**

Replace the entire contents of `src/server/agents/factory.ts`:

```typescript
import type { AgentSession } from './types'
import { OpenCodeSession } from './opencode/session'
import { resolveModelID } from './opencode/models'
import { openCodeServer } from '../opencode/server'

export interface CreateSessionOpts {
  cwd: string
  providerID: string
  model: 'sonnet' | 'opus'
  thinkingLevel: 'off' | 'low' | 'medium' | 'high'
  resumeSessionId?: string
  projectName?: string
}

export function createAgentSession(opts: CreateSessionOpts): AgentSession {
  if (!openCodeServer.client) {
    throw new Error('OpenCode server not ready')
  }
  const modelID = resolveModelID(opts.model, opts.thinkingLevel)
  return new OpenCodeSession(
    openCodeServer.client,
    opts.cwd,
    opts.providerID,
    modelID,
    opts.resumeSessionId,
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/agents/factory.ts
git commit -m "refactor: rewrite factory for OpenCode-only sessions"
```

### Task 9: Simplify SessionManager

**Files:**
- Modify: `src/server/agents/manager.ts`

- [ ] **Step 1: Remove tailer methods**

Remove all tailer-related code from `manager.ts`:
- Remove `import { SessionTailer } from './tailer'`
- Remove `private tailers = new Map<string, SessionTailer>()`
- Remove `startTailing()`, `getTailer()`, `stopTailing()` methods
- Update the `create()` log line: change `agent=${opts.agentType}` to `provider=${opts.providerID}`

The file should only contain: `sessions` Map, `create()`, `get()`, `kill()`.

- [ ] **Step 2: Commit**

```bash
git add src/server/agents/manager.ts
git commit -m "refactor: remove tailer management from SessionManager"
```

### Task 10: Rewrite begin-session.ts

**Files:**
- Modify: `src/server/agents/begin-session.ts`

- [ ] **Step 1: Rewrite begin-session**

Replace the file contents. Key changes:
- Remove all imports from `./kiro/` and `./claude/`
- Remove `KiroSessionTailer` setup block
- Read `project.providerID` instead of `project.agentType` / `project.agentProfile`
- Pass `providerID`, `model`, `thinkingLevel` to `sessionManager.create()`
- On follow-up (`existingSession`): call `session.updateModel()` before `sendMessage()` (supports mid-session model switch)

```typescript
import type { WebSocket } from 'ws'
import { db } from '../db/index'
import { cards, projects } from '../db/schema'
import { eq } from 'drizzle-orm'
import { sessionManager } from './manager'
import type { AgentSession, AgentMessage, SessionStatus } from './types'
import type { ConnectionManager } from '../ws/connections'
import type { DbMutator } from '../db/mutator'
import {
  createWorktree,
  runSetupCommands,
  slugify,
  worktreeExists,
} from '../worktree'
import { OpenCodeSession } from './opencode/session'

const DISPLAY_TYPES = new Set([
  'user', 'text', 'tool_call', 'tool_result', 'tool_progress', 'thinking', 'system', 'turn_end', 'error',
])

type HandlerPair = { message: (msg: AgentMessage) => void; exit: () => void }
const wsHandlers = new Map<number, Map<WebSocket, HandlerPair>>()

export function subscribeToSession(
  session: AgentSession,
  cardId: number,
  ws: WebSocket,
  connections: ConnectionManager,
  mutator: DbMutator,
): void {
  unsubscribeFromSession(cardId, ws)

  const messageHandler = (msg: AgentMessage) => {
    if (!DISPLAY_TYPES.has(msg.type)) return
    connections.send(ws, { type: 'agent:message', cardId, data: msg })
    if (msg.type === 'turn_end') {
      try {
        mutator.updateCard(cardId, {
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        })
      } catch (err) {
        console.error(`[session:${cardId}] failed to persist counters:`, err)
      }
    }
  }

  const exitHandler = () => {
    console.log(`[session:${cardId}] exit, status=${session.status}`)
    if (session.status === 'completed' || session.status === 'errored') {
      try {
        mutator.updateCard(cardId, {
          column: 'review',
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        })
      } catch (err) {
        console.error(`[session:${cardId}] failed to auto-move to review:`, err)
      }
    }
    connections.send(ws, {
      type: 'agent:status',
      data: {
        cardId,
        active: false,
        status: session.status as SessionStatus,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      },
    })
  }

  session.on('message', messageHandler)
  session.on('exit', exitHandler)

  if (!wsHandlers.has(cardId)) wsHandlers.set(cardId, new Map())
  wsHandlers.get(cardId)!.set(ws, { message: messageHandler, exit: exitHandler })
}

function unsubscribeFromSession(cardId: number, ws: WebSocket): void {
  const handlers = wsHandlers.get(cardId)?.get(ws)
  if (!handlers) return
  const session = sessionManager.get(cardId)
  if (session) {
    session.removeListener('message', handlers.message)
    session.removeListener('exit', handlers.exit)
  }
  wsHandlers.get(cardId)!.delete(ws)
  if (wsHandlers.get(cardId)!.size === 0) wsHandlers.delete(cardId)
}

export function unsubscribeAllSessions(ws: WebSocket): void {
  for (const [cardId] of wsHandlers) {
    if (!wsHandlers.get(cardId)?.has(ws)) continue
    unsubscribeFromSession(cardId, ws)
  }
}

function ensureWorktree(card: {
  id: number
  projectId: number | null
  useWorktree: boolean
  worktreePath: string | null
  worktreeBranch: string | null
  sourceBranch: string | null
  title: string
}, mutator: DbMutator): string {
  if (card.worktreePath) return card.worktreePath

  if (!card.projectId) throw new Error(`Card ${card.id} has no project`)
  const proj = db.select().from(projects).where(eq(projects.id, card.projectId)).get()
  if (!proj) throw new Error(`Project ${card.projectId} not found`)

  if (!card.useWorktree) {
    mutator.updateCard(card.id, { worktreePath: proj.path })
    return proj.path
  }

  const slug = card.worktreeBranch || slugify(card.title)
  const wtPath = `${proj.path}/.worktrees/${slug}`
  const branch = slug
  const source = card.sourceBranch ?? proj.defaultBranch ?? undefined

  if (!worktreeExists(wtPath)) {
    console.log(`[session:${card.id}] worktree setup at ${wtPath}`)
    createWorktree(proj.path, wtPath, branch, source ?? undefined)
    if (proj.setupCommands) {
      runSetupCommands(wtPath, proj.setupCommands)
    }
  }

  mutator.updateCard(card.id, { worktreePath: wtPath, worktreeBranch: branch })
  return wtPath
}

export async function beginSession(
  cardId: number,
  message: string | undefined,
  ws: WebSocket,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const card = db.select().from(cards).where(eq(cards.id, cardId)).get()
  if (!card) throw new Error(`Card ${cardId} not found`)
  if (!card.description) throw new Error(`Card ${cardId} has no description`)

  const existingSession = sessionManager.get(cardId)

  if (existingSession) {
    if (!message) throw new Error(`No message to send to existing session for card ${cardId}`)
    subscribeToSession(existingSession, cardId, ws, connections, mutator)

    // Support mid-session model switch
    if (existingSession instanceof OpenCodeSession) {
      existingSession.updateModel(card.model, card.thinkingLevel)
    }

    await existingSession.sendMessage(message)
    mutator.updateCard(cardId, { promptsSent: existingSession.promptsSent })

    connections.send(ws, {
      type: 'agent:status',
      data: {
        cardId,
        active: true,
        status: 'running',
        sessionId: card.sessionId,
        promptsSent: existingSession.promptsSent,
        turnsCompleted: existingSession.turnsCompleted,
      },
    })
  } else {
    const prompt = message ? card.description + '\n' + message : card.description
    const cwd = ensureWorktree(card, mutator)

    let providerID = 'anthropic'
    let projectName: string | undefined

    if (card.projectId) {
      const proj = db.select().from(projects).where(eq(projects.id, card.projectId)).get()
      if (proj) {
        projectName = proj.name.toLowerCase()
        providerID = proj.providerID ?? 'anthropic'
      }
    }

    const isResume = !!card.sessionId
    const session = sessionManager.create(cardId, {
      cwd,
      providerID,
      model: (card.model ?? 'sonnet') as 'sonnet' | 'opus',
      thinkingLevel: (card.thinkingLevel ?? 'high') as 'off' | 'low' | 'medium' | 'high',
      resumeSessionId: card.sessionId ?? undefined,
      projectName,
    })

    if (isResume) {
      session.promptsSent = card.promptsSent ?? 0
      session.turnsCompleted = card.turnsCompleted ?? 0
    }

    subscribeToSession(session, cardId, ws, connections, mutator)

    await session.start(prompt)
    await session.waitForReady()

    if (!isResume) {
      mutator.updateCard(cardId, {
        sessionId: session.sessionId,
        promptsSent: 1,
        turnsCompleted: 0,
      })
    }

    connections.send(ws, {
      type: 'agent:status',
      data: {
        cardId,
        active: true,
        status: 'running',
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      },
    })
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/agents/begin-session.ts
git commit -m "refactor: rewrite begin-session for OpenCode"
```

### Task 11: Rewrite session history handler

**Files:**
- Modify: `src/server/ws/handlers/sessions.ts`

- [ ] **Step 1: Rewrite sessions.ts**

Replace the entire file. Remove all Claude/Kiro imports and JSONL parsing. Use OpenCode SDK for history. **Critical:** Must send `session:history` batch response with `requestId` (not individual `agent:message` events) to match the existing WS protocol.

```typescript
import type { WebSocket } from 'ws'
import type { ClientMessage, AgentMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import { subscribeToSession } from '../../agents/begin-session'
import { sessionManager } from '../../agents/manager'
import { openCodeServer } from '../../opencode/server'

export async function handleSessionLoad(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'session:load' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { cardId, sessionId } = msg.data
  const { requestId } = msg

  if (!openCodeServer.client) {
    connections.send(ws, {
      type: 'mutation:error',
      requestId,
      error: 'OpenCode server not available',
    })
    return
  }

  const sdk = openCodeServer.client as any

  try {
    // Verify session exists
    const session = await sdk.session.get({ path: { id: sessionId } })
    if (!session) {
      connections.send(ws, {
        type: 'session:history',
        requestId,
        cardId,
        messages: [],
      })
      return
    }

    // Load full message history
    const rawMessages = await sdk.session.messages({ path: { id: sessionId } })
    const msgList = rawMessages.data ?? rawMessages ?? []

    // Normalize all messages into AgentMessage format
    const normalized: AgentMessage[] = []
    for (const m of msgList) {
      normalized.push(...normalizeSessionMessage(m))
    }

    // Send batched history response (matches existing protocol)
    connections.send(ws, {
      type: 'session:history',
      requestId,
      cardId,
      messages: normalized,
    })

    // If there's a live session in the manager, subscribe to it
    const liveSession = sessionManager.get(cardId)
    if (liveSession) {
      subscribeToSession(liveSession, cardId, ws, connections, mutator)
    }
  } catch (err) {
    console.error(`[session:load] error loading session ${sessionId}:`, err)
    connections.send(ws, {
      type: 'mutation:error',
      requestId,
      error: `Failed to load session: ${err}`,
    })
  }
}

/**
 * Normalize an OpenCode stored message into AgentMessage(s).
 * A single OpenCode message may have multiple parts (text + tool calls),
 * so this returns an array.
 */
function normalizeSessionMessage(msg: Record<string, unknown>): AgentMessage[] {
  const results: AgentMessage[] = []
  const role = msg.role as string
  const parts = (msg.parts ?? []) as Array<Record<string, unknown>>
  const ts = msg.createdAt ? new Date(msg.createdAt as string).getTime() : Date.now()

  for (const part of parts) {
    const partType = part.type as string

    if (partType === 'text') {
      results.push({
        type: role === 'user' ? 'user' : 'text',
        role: role === 'user' ? 'user' : 'assistant',
        content: (part.text as string) ?? '',
        timestamp: ts,
      })
    }

    if (partType === 'thinking' || partType === 'reasoning') {
      results.push({
        type: 'thinking',
        role: 'assistant',
        content: (part.text as string) ?? (part.content as string) ?? '',
        timestamp: ts,
      })
    }

    if (partType === 'tool-invocation') {
      const inv = part.toolInvocation as Record<string, unknown> | undefined
      if (inv) {
        results.push({
          type: 'tool_call',
          role: 'assistant',
          content: '',
          toolCall: {
            id: inv.toolCallId as string,
            name: inv.toolName as string,
            params: inv.args as Record<string, unknown>,
          },
          timestamp: ts,
        })
        if (inv.state === 'result') {
          const output = typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result)
          results.push({
            type: 'tool_result',
            role: 'assistant',
            content: output,
            toolResult: {
              id: inv.toolCallId as string,
              output,
              isError: false,
            },
            timestamp: ts,
          })
        }
      }
    }
  }

  return results
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/ws/handlers/sessions.ts
git commit -m "refactor: rewrite session history handler for OpenCode SDK"
```

## Chunk 3: Deletion, Frontend, Config

### Task 12: Backup DB and push schema

**Files:**
- Modify: `data/dispatcher.db`

- [ ] **Step 1: Backup the database**

Run: `cp data/dispatcher.db data/dispatcher.db.backup`

- [ ] **Step 2: Push schema changes**

Run: `pnpm db:push`
Expected: Drizzle applies the schema diff (adds provider_id, removes agent_type and agent_profile)

- [ ] **Step 3: Verify schema**

Run: `sqlite3 data/dispatcher.db ".schema projects" | head -20`
Expected: Shows `provider_id` column, no `agent_type` or `agent_profile`

- [ ] **Step 4: Delete all cards**

Run: `sqlite3 data/dispatcher.db "DELETE FROM cards;"`

- [ ] **Step 5: Update project providerIDs**

Set appropriate providerID for each project. Run these manually based on your projects:

```bash
sqlite3 data/dispatcher.db "UPDATE projects SET provider_id = 'anthropic' WHERE 1=1;"
# Then update specific projects:
# sqlite3 data/dispatcher.db "UPDATE projects SET provider_id = 'kiro-okkanti' WHERE name = 'Okkanti';"
# sqlite3 data/dispatcher.db "UPDATE projects SET provider_id = 'kiro-trackable' WHERE name = 'Trackable';"
```

- [ ] **Step 6: Commit**

```bash
git commit -m "data: backup db, push schema, clean slate for OpenCode migration"
```

### Task 13: Delete old agent implementations

**Files:**
- Delete: `src/server/agents/claude/` (entire directory)
- Delete: `src/server/agents/kiro/` (entire directory)
- Delete: `src/server/agents/tailer.ts`

- [ ] **Step 1: Delete the directories and file**

```bash
rm -rf src/server/agents/claude/
rm -rf src/server/agents/kiro/
rm -f src/server/agents/tailer.ts
```

- [ ] **Step 2: Verify no broken imports remain**

Run: `pnpm exec tsc --noEmit`
Expected: Clean compile (or only unrelated errors). All imports of deleted files should already be removed by prior tasks.

- [ ] **Step 3: Commit**

```bash
git add -A src/server/agents/claude/ src/server/agents/kiro/ src/server/agents/tailer.ts
git commit -m "delete: remove Claude SDK and Kiro ACP agent implementations"
```

### Task 14: Update WS handler imports

**Files:**
- Modify: `src/server/ws/handlers/agents.ts`

- [ ] **Step 1: Update agent type import**

In `src/server/ws/handlers/agents.ts`, ensure:
- `SessionStatus` import still works from `../../agents/types`
- `sessionManager` import still works from `../../agents/manager`
- `beginSession` import still works from `../../agents/begin-session`
- No references to `AgentType` as a discriminator (it's always `'opencode'` now)

Check for any remaining references to `'claude'` or `'kiro'` strings in handler files.

- [ ] **Step 2: Commit if changes needed**

```bash
git add src/server/ws/handlers/
git commit -m "refactor: clean up WS handler imports after agent deletion"
```

### Task 15: Update ProjectForm frontend

**Files:**
- Modify: `app/components/ProjectForm.tsx`
- Modify: `app/stores/project-store.ts`

- [ ] **Step 1: Replace agentType with providerID**

In `ProjectForm.tsx`:
- Replace `agentType` field in the Project interface with `providerID: string`
- Remove `agentProfile` field from the interface
- Replace the agent type dropdown with a provider dropdown:
  - Options: `anthropic` (label: "Anthropic"), `kiro-okkanti` (label: "Kiro — Okkanti"), `kiro-trackable` (label: "Kiro — Trackable")
- Remove the entire Kiro HOME directory browser conditional block (the `DirectoryBrowser` and `agentProfile` input)
- Remove `agentProfile` from form state and validation
- Update the submit handler to send `providerID` instead of `agentType`/`agentProfile`

- [ ] **Step 2: Delete DirectoryBrowser if only used for Kiro**

Run: `grep -r "DirectoryBrowser" app/`

If only referenced in ProjectForm, delete it:

```bash
rm app/components/DirectoryBrowser.tsx
```

- [ ] **Step 3: Update project store**

In `app/stores/project-store.ts` (or wherever project mutations are defined):
- Replace `agentType`/`agentProfile` with `providerID` in mutation payloads

- [ ] **Step 4: Verify frontend compiles**

Run: `pnpm exec tsc --noEmit`
Expected: Clean compile

- [ ] **Step 5: Commit**

```bash
git add app/components/ProjectForm.tsx app/stores/project-store.ts
git commit -m "feat: replace agent type selector with provider dropdown"
```

### Task 16: Wire OpenCode server startup

**Files:**
- Modify: `src/server/ws/server.ts`

- [ ] **Step 1: Start OpenCode server on WS server creation**

In `src/server/ws/server.ts`, import and start the OpenCode server:

```typescript
import { openCodeServer } from '../opencode/server'
```

In the `wsServerPlugin()` function's `configureServer` block, after `createWsServer(server.httpServer)`, add:

```typescript
// Hook crash notification to broadcast to all connected clients
openCodeServer.onCrash = () => {
  connections.broadcast({
    type: 'agent:message',
    cardId: -1,
    data: { type: 'error', role: 'system', content: 'OpenCode server crashed, restarting...', timestamp: Date.now() },
  })
}

openCodeServer.start().catch((err) => {
  console.error('[opencode] failed to start:', err)
})
```

- [ ] **Step 2: Commit**

```bash
git add src/server/ws/server.ts
git commit -m "feat: start OpenCode server on Dispatcher boot"
```

## Chunk 4: Config & Verification

### Task 17: Create OpenCode configuration file

**Files:**
- Create: `data/opencode.json`

- [ ] **Step 1: Create the OpenCode config**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {
      "models": {
        "claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6",
          "limit": { "context": 200000, "output": 65536 }
        },
        "claude-sonnet-4-6-thinking": {
          "name": "Claude Sonnet 4.6 (Thinking)",
          "limit": { "context": 200000, "output": 65536 },
          "options": {
            "thinking": { "type": "enabled", "budgetTokens": 16000 }
          }
        },
        "claude-opus-4-6": {
          "name": "Claude Opus 4.6",
          "limit": { "context": 200000, "output": 65536 }
        },
        "claude-opus-4-6-thinking": {
          "name": "Claude Opus 4.6 (Thinking)",
          "limit": { "context": 200000, "output": 65536 },
          "options": {
            "thinking": { "type": "enabled", "budgetTokens": 16000 }
          }
        }
      }
    }
  }
}
```

Note: Kiro provider configs (`kiro-okkanti`, `kiro-trackable`) will be added once the opencode-kiro-auth fork is ready. Anthropic provider works with API key stored via `opencode /connect`.

Note: The thinking budget tokens for low/medium/high variants will need tuning. For now, all thinking variants use the same budget. Custom variants can be added later to differentiate.

- [ ] **Step 2: Commit**

```bash
git add data/opencode.json
git commit -m "config: add OpenCode server configuration"
```

### Task 18: End-to-end smoke test

- [ ] **Step 1: Install OpenCode CLI**

Ensure `opencode` is installed globally:
Run: `which opencode`
If missing: `npm install -g opencode` (or follow OpenCode's install docs)

- [ ] **Step 2: Start Dispatcher**

Run: `pnpm dev`
Expected: Dispatcher starts, logs `[opencode] server ready on port 4097`

- [ ] **Step 3: Verify OpenCode server health**

Run: `curl http://localhost:4097/api/health`
Expected: 200 OK

- [ ] **Step 4: Test TUI attach**

Run: `opencode attach http://localhost:4097`
Expected: OpenCode TUI connects to the running server

- [ ] **Step 5: Test session via Dispatcher UI**

1. Open `dispatch.rbrcurtis.com` (or `localhost:6194`)
2. Create a card on an Anthropic project
3. Move to running — should start an OpenCode session
4. Verify messages stream to the SessionView
5. Send a follow-up message
6. Stop the session — card should move to review

- [ ] **Step 6: Test session history**

1. Click on the review card
2. Session history should load via OpenCode SDK
3. Verify messages render correctly

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: OpenCode migration complete — verified end-to-end"
```
