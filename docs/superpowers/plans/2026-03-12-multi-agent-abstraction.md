# Multi-Agent Abstraction Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Claude Code integration into an abstract agent service, enabling future multi-agent support (Kiro, etc.)

**Architecture:** Abstract `AgentSession` class with `ClaudeSession` implementation. Factory creates the right session based on project config. Unified `AgentMessage` format flows through WS protocol and client stores. Each agent turn emits one `AgentMessage` per logical block (text, tool_call, thinking, etc.) rather than nested content arrays.

**Tech Stack:** TypeScript, EventEmitter, Drizzle ORM, MobX, React, WebSocket

**Spec:** `docs/superpowers/specs/2026-03-12-multi-agent-abstraction-design.md`

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `src/server/agents/types.ts` | `AgentType`, `AgentMessage`, `SessionStatus`, `AgentSession` abstract class |
| `src/server/agents/claude/messages.ts` | Claude SDK → `AgentMessage` normalization functions |
| `src/server/agents/claude/session.ts` | `ClaudeSession` extending `AgentSession` (moved from `src/server/claude/protocol.ts`) |
| `src/server/agents/claude/session-path.ts` | SDK session file path util (moved from `src/server/claude/session-path.ts`) |
| `src/server/agents/factory.ts` | `createAgentSession()` factory |
| `src/server/agents/manager.ts` | Agent-agnostic `SessionManager` (moved from `src/server/claude/manager.ts`) |
| `src/server/agents/begin-session.ts` | Session orchestration (moved from `src/server/claude/begin-session.ts`) |
| `src/server/agents/tailer.ts` | `SessionTailer` (moved from `src/server/claude/tailer.ts`) |
| `src/server/ws/handlers/agents.ts` | WS handlers (moved from `src/server/ws/handlers/claude.ts`) |

### Modified files
| File | Changes |
|------|---------|
| `src/server/db/schema.ts` | Add `agentType`, `agentProfile` to projects |
| `src/shared/ws-protocol.ts` | Rename `claude:*` → `agent:*`, use `AgentMessage` schema |
| `src/server/ws/handlers.ts` | Update imports and case labels |
| `src/server/ws/handlers/sessions.ts` | Normalize history to `AgentMessage[]`, update event names |
| `app/stores/session-store.ts` | Store `AgentMessage`, new ingest logic, rename methods |
| `app/stores/root-store.ts` | Route `agent:message`, `agent:status` |
| `app/components/MessageBlock.tsx` | Render `AgentMessage` types instead of Claude content arrays |
| `app/components/SessionView.tsx` | Update `toolOutputs` memo, types |

### Deleted files
| File | Reason |
|------|--------|
| `src/server/claude/protocol.ts` | Moved to `agents/claude/session.ts` |
| `src/server/claude/manager.ts` | Moved to `agents/manager.ts` |
| `src/server/claude/begin-session.ts` | Moved to `agents/begin-session.ts` |
| `src/server/claude/tailer.ts` | Moved to `agents/tailer.ts` |
| `src/server/claude/session-path.ts` | Moved to `agents/claude/session-path.ts` |
| `src/server/claude/types.ts` | Replaced by `agents/types.ts` |
| `src/server/ws/handlers/claude.ts` | Moved to `handlers/agents.ts` |

---

## Chunk 1: Foundation Types + Normalization

These files are additive — they don't break any existing code.

### Task 1: Create `src/server/agents/types.ts`

**Files:**
- Create: `src/server/agents/types.ts`

- [ ] **Step 1: Create the types file**

```ts
import { EventEmitter } from 'events'

export type AgentType = 'claude' | 'kiro'

export type SessionStatus = 'starting' | 'running' | 'completed' | 'errored' | 'stopped'

export type AgentMessage = {
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'system' | 'turn_end' | 'error' | 'user' | 'tool_progress'
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCall?: {
    id: string
    name: string
    params?: Record<string, unknown>
  }
  toolResult?: {
    id: string
    output: string
    isError?: boolean
  }
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
    cacheWrite?: number
    contextWindow?: number
  }
  modelUsage?: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number
    contextWindow?: number
  }>
  meta?: Record<string, unknown>
  timestamp: number
}

export interface AgentSessionEvents {
  message: (msg: AgentMessage) => void
  exit: (code: number) => void
}

export abstract class AgentSession extends EventEmitter {
  abstract sessionId: string | null
  abstract status: SessionStatus
  abstract promptsSent: number
  abstract turnsCompleted: number

  model?: string
  thinkingLevel?: string

  queryStartIndex = 0

  abstract start(prompt: string): Promise<void>
  abstract sendMessage(content: string): Promise<void>
  abstract kill(): Promise<void>
  abstract waitForReady(): Promise<void>
}
```

Note: `AgentMessage` includes `user` in the type union (for user messages in conversation), `tool_progress` for live tool execution status, `modelUsage` for cost calculation in `turn_end` messages (preserving the per-model breakdown that `ResultBlock` needs), and `meta` for agent-specific data that doesn't fit other fields.

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors from the new file (existing errors are OK)

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/types.ts
git commit -m "feat: add AgentSession abstract class and AgentMessage types"
```

### Task 2: Create `src/server/agents/claude/messages.ts`

**Files:**
- Create: `src/server/agents/claude/messages.ts`

This file converts raw Claude SDK messages into `AgentMessage[]`. A single SDK message (e.g., an assistant message with `[text, tool_use, thinking]` content) becomes multiple `AgentMessage` events.

- [ ] **Step 1: Create the normalization module**

```ts
import type { AgentMessage } from '../types'

type ContentBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  thinking?: string
}

/**
 * Convert a raw Claude SDK message into one or more AgentMessages.
 * An assistant message with multiple content blocks becomes multiple events.
 */
export function normalizeClaudeMessage(msg: Record<string, unknown>): AgentMessage[] {
  const now = Date.now()
  const type = msg.type as string

  if (type === 'user') {
    return [normalizeUserMessage(msg, now)]
  }

  if (type === 'assistant') {
    return normalizeAssistantMessage(msg, now)
  }

  if (type === 'result') {
    return [normalizeResultMessage(msg, now)]
  }

  if (type === 'system') {
    return [normalizeSystemMessage(msg, now)]
  }

  if (type === 'tool_progress') {
    const inner = (msg.message ?? msg) as Record<string, unknown>
    return [{
      type: 'tool_progress' as const,
      role: 'assistant' as const,
      content: (inner.tool_name as string) ?? '',
      meta: { elapsedSeconds: inner.elapsed_time_seconds },
      timestamp: now,
    }]
  }

  // Skip unknown types
  return []
}

function normalizeUserMessage(msg: Record<string, unknown>, ts: number): AgentMessage {
  const inner = msg.message as { role?: string; content?: unknown } | undefined
  let content = ''
  if (typeof inner?.content === 'string') {
    content = inner.content
  } else if (Array.isArray(inner?.content)) {
    content = (inner!.content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n')
  }
  return { type: 'user', role: 'user', content, timestamp: ts }
}

function normalizeAssistantMessage(msg: Record<string, unknown>, ts: number): AgentMessage[] {
  const inner = msg.message as {
    content?: ContentBlock[]
    usage?: Record<string, number>
    model?: string
  } | undefined
  const content = inner?.content
  if (!content || !Array.isArray(content)) return []

  const isSidechain = msg.isSidechain as boolean | undefined
  const usage = inner?.usage
  const usageData = usage ? {
    inputTokens: (usage.input_tokens as number) ?? 0,
    outputTokens: (usage.output_tokens as number) ?? 0,
    cacheRead: (usage.cache_read_input_tokens as number) ?? 0,
    cacheWrite: (usage.cache_creation_input_tokens as number) ?? 0,
  } : undefined

  const results: AgentMessage[] = []

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      results.push({
        type: 'text',
        role: 'assistant',
        content: block.text,
        usage: usageData,
        meta: isSidechain ? { isSidechain: true } : undefined,
        timestamp: ts,
      })
    } else if (block.type === 'tool_use' && block.name && block.input) {
      results.push({
        type: 'tool_call',
        role: 'assistant',
        content: '',
        toolCall: {
          id: block.id ?? '',
          name: block.name,
          params: block.input,
        },
        timestamp: ts,
      })
    } else if (block.type === 'thinking' && block.thinking) {
      results.push({
        type: 'thinking',
        role: 'assistant',
        content: block.thinking,
        timestamp: ts,
      })
    }
  }

  // Attach usage only to the first text block (avoid double-counting)
  // If no text block, attach to first result
  if (usageData && results.length > 1) {
    for (let i = 1; i < results.length; i++) {
      if (results[i].usage) results[i].usage = undefined
    }
  }

  return results
}

function normalizeResultMessage(msg: Record<string, unknown>, ts: number): AgentMessage {
  const inner = (msg.message ?? msg) as Record<string, unknown>
  const subtype = inner.subtype as string | undefined
  const rawTs = (msg.ts ?? inner.ts ?? inner._mtime) as string | undefined
  const timestamp = rawTs ? new Date(rawTs).getTime() : ts

  const modelUsage = inner.modelUsage as Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number
    contextWindow?: number
  }> | undefined

  // Extract contextWindow from first model entry
  let contextWindow: number | undefined
  if (modelUsage) {
    const first = Object.values(modelUsage)[0]
    if (first?.contextWindow) contextWindow = first.contextWindow
  }

  return {
    type: 'turn_end',
    role: 'system',
    content: subtype ?? 'success',
    usage: contextWindow ? { inputTokens: 0, outputTokens: 0, contextWindow } : undefined,
    modelUsage: modelUsage ?? undefined,
    meta: {
      subtype,
      durationMs: inner.duration_ms,
      totalCostUsd: inner.total_cost_usd,
      errors: inner.errors,
    },
    timestamp,
  }
}

function normalizeSystemMessage(msg: Record<string, unknown>, ts: number): AgentMessage {
  const inner = (msg.message ?? msg) as Record<string, unknown>
  const subtype = inner.subtype as string | undefined

  return {
    type: 'system',
    role: 'system',
    content: (inner.content as string) ?? '',
    meta: {
      subtype,
      model: inner.model,
      sessionId: inner.session_id ?? (msg as Record<string, unknown>).session_id,
      ...(subtype === 'compact_boundary' && { compactMetadata: inner.compact_metadata }),
    },
    timestamp: ts,
  }
}

/**
 * Normalize a tool_result from a user message's content array.
 * Called separately when processing history to extract tool results as standalone messages.
 */
export function normalizeToolResult(block: {
  type: string
  tool_use_id?: string
  content?: unknown
}, ts: number): AgentMessage | null {
  if (block.type !== 'tool_result' || !block.tool_use_id) return null

  let output = ''
  if (typeof block.content === 'string') {
    output = block.content
  } else if (Array.isArray(block.content)) {
    output = (block.content as Array<{ type: string; text?: string }>)
      .filter(b => b.text)
      .map(b => b.text!)
      .join('\n')
  }

  return {
    type: 'tool_result',
    role: 'user',
    content: '',
    toolResult: {
      id: block.tool_use_id,
      output,
    },
    timestamp: ts,
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/claude/messages.ts
git commit -m "feat: Claude SDK → AgentMessage normalization functions"
```

### Task 3: Create `src/server/agents/factory.ts`

**Files:**
- Create: `src/server/agents/factory.ts`

- [ ] **Step 1: Create factory (Phase 1 — only Claude)**

```ts
import type { AgentType, AgentSession } from './types'
import { ClaudeSession } from './claude/session'

export interface CreateSessionOpts {
  agentType: AgentType
  cwd: string
  resumeSessionId?: string
  projectName?: string
  model?: string
  thinkingLevel?: string
  agentProfile?: string
}

export function createAgentSession(opts: CreateSessionOpts): AgentSession {
  switch (opts.agentType) {
    case 'claude':
      return new ClaudeSession(
        opts.cwd,
        opts.resumeSessionId,
        opts.projectName,
        (opts.model as 'sonnet' | 'opus') ?? 'sonnet',
        (opts.thinkingLevel as 'off' | 'low' | 'medium' | 'high') ?? 'high',
      )
    case 'kiro':
      throw new Error('Kiro agent not yet implemented')
    default:
      throw new Error(`Unknown agent type: ${opts.agentType}`)
  }
}
```

Note: This file references `ClaudeSession` from its new location. It will compile only after Task 4 (ClaudeSession move). Do NOT commit separately — this gets committed with the Chunk 2 batch in Task 8.

---

## Chunk 2: Backend File Moves + Refactor

All server-side `src/server/claude/*` files move to `src/server/agents/` and get refactored to use the abstract types. These must be done together because they cross-reference each other.

### Task 4: Move and refactor ClaudeSession

**Files:**
- Create: `src/server/agents/claude/session.ts` (from `src/server/claude/protocol.ts`)
- Delete: `src/server/claude/protocol.ts`

- [ ] **Step 1: Create `src/server/agents/claude/session.ts`**

This is the existing `ClaudeSession` refactored to:
1. Extend `AgentSession` instead of raw `EventEmitter`
2. Use `normalizeClaudeMessage()` in `handleMessage()` to emit `AgentMessage` events
3. Rename `sendUserMessage()` → `sendMessage()`
4. Add `waitForReady()` method
5. Import `SessionStatus` from `../types` instead of `./types`

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options as SDKOptions, Query } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { AgentSession } from '../types'
import type { SessionStatus } from '../types'
import { normalizeClaudeMessage } from './messages'

const MEMORY_MCP_BIN = '/home/ryan/Code/memory-mcp/dist/index.js'
const DEFAULT_QDRANT_URL = 'http://localhost:6333'

function getMemoryMcpEnv(cwd: string): Record<string, string> {
  try {
    const raw = readFileSync(join(cwd, '.mcp.json'), 'utf8')
    const cfg = JSON.parse(raw) as { mcpServers?: Record<string, { env?: Record<string, string> }> }
    const env = cfg.mcpServers?.['shared-memory']?.env
    if (env) return env
  } catch { /* not found or invalid */ }
  try {
    const raw = readFileSync(join(homedir(), '.claude.json'), 'utf8')
    const cfg = JSON.parse(raw) as { mcpServers?: Record<string, { env?: Record<string, string> }> }
    return cfg.mcpServers?.['shared-memory']?.env ?? {}
  } catch {
    return {}
  }
}

export class ClaudeSession extends AgentSession {
  sessionId: string | null = null
  status: SessionStatus = 'starting'
  promptsSent = 0
  turnsCompleted = 0

  private queryInstance: Query | null = null
  private abortController: AbortController | null = null
  private resumeSessionId?: string

  constructor(
    private cwd: string,
    resumeSessionId?: string,
    private projectName?: string,
    model: 'sonnet' | 'opus' = 'sonnet',
    thinkingLevel: 'off' | 'low' | 'medium' | 'high' = 'high',
  ) {
    super()
    this.resumeSessionId = resumeSessionId
    // For resumed sessions, set sessionId immediately so waitForReady() resolves
    if (resumeSessionId) this.sessionId = resumeSessionId
    this.model = model
    this.thinkingLevel = thinkingLevel
  }

  async waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for session init')), 30_000)
      const onMessage = () => {
        if (this.sessionId) {
          clearTimeout(timeout)
          this.off('message', onMessage)
          resolve()
        }
      }
      this.on('message', onMessage)
      this.on('exit', () => {
        clearTimeout(timeout)
        this.off('message', onMessage)
        reject(new Error('Session exited before init'))
      })
    })
  }

  async start(prompt: string): Promise<void> {
    console.log(`[session] start() called, cwd=${this.cwd}, prompt length=${prompt.length}`)
    const userMsgs = normalizeClaudeMessage({
      type: 'user',
      message: { role: 'user', content: prompt },
    })
    for (const m of userMsgs) this.emit('message', m)
    await this.runQuery(prompt, this.resumeSessionId)
  }

  private async runQuery(prompt: string, resumeId?: string): Promise<void> {
    this.abortController = new AbortController()

    const env = { ...process.env }
    delete env.CLAUDECODE

    const model = this.model as string
    const thinkingLevel = this.thinkingLevel as string

    const opts: SDKOptions = {
      cwd: this.cwd,
      env,
      abortController: this.abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'user', 'local'],
      includePartialMessages: false,
      model: model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
      thinking: thinkingLevel === 'off' ? { type: 'disabled' } : { type: 'adaptive' },
      effort: thinkingLevel === 'off' ? 'low' : thinkingLevel,
    }

    if (resumeId) opts.resume = resumeId

    if (this.projectName) {
      const mcpEnv = getMemoryMcpEnv(this.cwd)
      opts.mcpServers = {
        'shared-memory': {
          command: 'node',
          args: [MEMORY_MCP_BIN],
          env: {
            QDRANT_URL: mcpEnv.QDRANT_URL ?? DEFAULT_QDRANT_URL,
            ...(mcpEnv.QDRANT_API_KEY ? { QDRANT_API_KEY: mcpEnv.QDRANT_API_KEY } : {}),
            DEFAULT_AGENT: mcpEnv.DEFAULT_AGENT ?? 'claude-code',
            DEFAULT_PROJECT: this.projectName,
          },
        },
      }
    }

    this.queryInstance = query({ prompt, options: opts })

    this.consumeMessages().catch((err) => {
      console.error('Query consumption error:', err)
      this.status = 'errored'
      this.emit('exit', 1)
    })
  }

  private async consumeMessages(): Promise<void> {
    if (!this.queryInstance) return
    try {
      for await (const msg of this.queryInstance) {
        this.handleMessage(msg as Record<string, unknown>)
      }
      this.status = 'completed'
      console.log(`[session] completed normally, turns=${this.turnsCompleted}`)
      this.emit('exit', 0)
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.status = 'completed'
        this.emit('exit', 0)
      } else {
        console.error('[session] SDK query error:', err)
        this.status = 'errored'
        this.emit('exit', 1)
      }
    } finally {
      this.queryInstance = null
      this.abortController = null
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Capture session ID from system init (fresh sessions only)
    if (msg.type === 'system' && typeof msg.session_id === 'string') {
      if (!this.sessionId && !this.resumeSessionId) {
        this.sessionId = msg.session_id
      }
      this.status = 'running'
      console.log(`[session] status → running, sessionId=${this.sessionId ?? this.resumeSessionId}`)
    }

    // Normalize and emit each AgentMessage
    const agentMsgs = normalizeClaudeMessage(msg)
    for (const am of agentMsgs) {
      this.emit('message', am)
    }

    if (msg.type === 'result') {
      this.turnsCompleted++
    }
  }

  async sendMessage(content: string): Promise<void> {
    console.log(`[session] sendMessage, length=${content.length}, promptsSent=${this.promptsSent + 1}`)
    this.promptsSent++
    this.queryStartIndex = 0 // Reset for subscription replay

    const userMsgs = normalizeClaudeMessage({
      type: 'user',
      message: { role: 'user', content },
    })
    for (const m of userMsgs) this.emit('message', m)

    if (this.queryInstance) {
      try { await this.queryInstance.interrupt() } catch { /* ignore */ }
    }
    const resumeId = this.sessionId ?? this.resumeSessionId
    if (!resumeId) return
    this.status = 'starting'
    await this.runQuery(content, resumeId)
  }

  async kill(): Promise<void> {
    if (this.abortController) this.abortController.abort()
    if (this.queryInstance) {
      try { await this.queryInstance.interrupt() } catch { /* ignore */ }
    }
  }
}
```

- [ ] **Step 2: Delete old file**

```bash
rm src/server/claude/protocol.ts
```

### Task 5: Move session-path.ts

**Files:**
- Create: `src/server/agents/claude/session-path.ts` (copy from `src/server/claude/session-path.ts`)
- Delete: `src/server/claude/session-path.ts`

- [ ] **Step 1: Copy file unchanged**

```bash
cp src/server/claude/session-path.ts src/server/agents/claude/session-path.ts
rm src/server/claude/session-path.ts
```

### Task 6: Move and refactor SessionManager

**Files:**
- Create: `src/server/agents/manager.ts` (from `src/server/claude/manager.ts`)
- Delete: `src/server/claude/manager.ts`

- [ ] **Step 1: Create `src/server/agents/manager.ts`**

Key changes: Use `AgentSession` instead of `ClaudeSession`. Use `createAgentSession` factory. Updated `create()` signature to accept `CreateSessionOpts`.

```ts
import { EventEmitter } from 'events'
import type { AgentSession } from './types'
import { createAgentSession } from './factory'
import type { CreateSessionOpts } from './factory'
import { SessionTailer } from './tailer'

class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>()
  private tailers = new Map<string, SessionTailer>()

  create(cardId: number, opts: CreateSessionOpts): AgentSession {
    const key = `card-${cardId}`
    const existing = this.sessions.get(key)
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      console.log(`[session:${cardId}] blocked: session already ${existing.status}`)
      throw new Error(`Session already ${existing.status} for card ${cardId}`)
    }
    const session = createAgentSession(opts)
    console.log(`[session:${cardId}] created, agent=${opts.agentType}, model=${opts.model}, resume=${!!opts.resumeSessionId}`)
    this.sessions.set(key, session)
    this.emit('session', cardId, session)
    return session
  }

  get(cardId: number): AgentSession | undefined {
    return this.sessions.get(`card-${cardId}`)
  }

  async kill(cardId: number): Promise<void> {
    const key = `card-${cardId}`
    const session = this.sessions.get(key)
    if (session) {
      console.log(`[session:${cardId}] kill() called`)
      await session.kill()
      this.sessions.delete(key)
    }
  }

  startTailing(cardId: number, filePath: string): SessionTailer {
    const key = `card-${cardId}`
    const existing = this.tailers.get(key)
    if (existing) return existing
    const tailer = new SessionTailer(filePath, cardId)
    this.tailers.set(key, tailer)
    tailer.start()
    tailer.on('stale', () => { this.tailers.delete(key) })
    return tailer
  }

  getTailer(cardId: number): SessionTailer | undefined {
    return this.tailers.get(`card-${cardId}`)
  }

  stopTailing(cardId: number): void {
    const key = `card-${cardId}`
    const tailer = this.tailers.get(key)
    if (tailer) { tailer.stop(); this.tailers.delete(key) }
  }
}

export const sessionManager = new SessionManager()
```

- [ ] **Step 2: Delete old file**

```bash
rm src/server/claude/manager.ts
```

### Task 7: Move tailer.ts (unchanged)

**Files:**
- Create: `src/server/agents/tailer.ts`
- Delete: `src/server/claude/tailer.ts`

- [ ] **Step 1: Copy file unchanged**

```bash
cp src/server/claude/tailer.ts src/server/agents/tailer.ts
rm src/server/claude/tailer.ts
```

### Task 8: Move and refactor begin-session.ts

**Files:**
- Create: `src/server/agents/begin-session.ts` (from `src/server/claude/begin-session.ts`)
- Delete: `src/server/claude/begin-session.ts`

Key changes:
- Use `AgentSession` type and `sessionManager.create()` with opts object
- Replace `waitForInit()` with `session.waitForReady()`
- Replace `sendUserMessage()` with `sendMessage()`
- Emit `agent:message` and `agent:status` instead of `claude:*`
- Read project `agentType` for factory
- Messages emitted by session are already `AgentMessage` — forward directly

- [ ] **Step 1: Create `src/server/agents/begin-session.ts`**

```ts
import type { WebSocket } from 'ws'
import { db } from '../db/index'
import { cards, projects } from '../db/schema'
import { eq } from 'drizzle-orm'
import { sessionManager } from './manager'
import type { AgentSession } from './types'
import type { AgentMessage, SessionStatus } from './types'
import type { ConnectionManager } from '../ws/connections'
import type { DbMutator } from '../db/mutator'
import {
  createWorktree,
  runSetupCommands,
  slugify,
  worktreeExists,
} from '../worktree'

function registerHandlers(
  session: AgentSession,
  cardId: number,
  ws: WebSocket,
  connections: ConnectionManager,
  mutator: DbMutator,
) {
  session.on('message', (msg: AgentMessage) => {
    // Only forward displayable types
    const display = new Set(['user', 'text', 'tool_call', 'tool_result', 'tool_progress', 'thinking', 'system', 'turn_end', 'error'])
    if (!display.has(msg.type)) return

    connections.send(ws, {
      type: 'agent:message',
      cardId,
      data: msg,
    })

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
  })

  session.on('exit', () => {
    console.log(`[session:${cardId}] exit, status=${session.status}`)
    if (session.status !== 'completed' && session.status !== 'errored') return
    try {
      mutator.updateCard(cardId, {
        column: 'review',
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      })
    } catch (err) {
      console.error(`[session:${cardId}] failed to auto-move to review:`, err)
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
  })
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
    if (proj.setupCommands) runSetupCommands(wtPath, proj.setupCommands)
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
  console.log(`[session:${cardId}] beginSession called, existingSession=${!!existingSession}, message=${!!message}`)

  if (existingSession) {
    if (!message) throw new Error(`No message to send to existing session for card ${cardId}`)
    console.log(`[session:${cardId}] existing session, sending follow-up`)

    existingSession.removeAllListeners('message')
    existingSession.removeAllListeners('exit')
    registerHandlers(existingSession, cardId, ws, connections, mutator)

    existingSession.model = card.model
    existingSession.thinkingLevel = card.thinkingLevel

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
    console.log(`[session:${cardId}] no session, creating. prompt length=${prompt.length}`)

    const cwd = ensureWorktree(card, mutator)

    let projectName: string | undefined
    let agentType: 'claude' | 'kiro' = 'claude'
    if (card.projectId) {
      const proj = db.select().from(projects).where(eq(projects.id, card.projectId)).get()
      if (proj) {
        projectName = proj.name.toLowerCase()
        agentType = (proj.agentType as 'claude' | 'kiro') ?? 'claude'
      }
    }

    const isResume = !!card.sessionId
    const session = sessionManager.create(cardId, {
      agentType,
      cwd,
      resumeSessionId: card.sessionId ?? undefined,
      projectName,
      model: card.model,
      thinkingLevel: card.thinkingLevel,
    })

    if (isResume) {
      session.promptsSent = card.promptsSent ?? 0
      session.turnsCompleted = card.turnsCompleted ?? 0
    }

    registerHandlers(session, cardId, ws, connections, mutator)

    session.promptsSent++
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

- [ ] **Step 2: Delete old files and directory**

```bash
rm src/server/claude/begin-session.ts
rm src/server/claude/types.ts
rmdir src/server/claude 2>/dev/null || rm -r src/server/claude
```

- [ ] **Step 3: Commit all backend moves**

```bash
git add -A src/server/agents/ && git add -u src/server/claude/
git commit -m "refactor: move claude/ → agents/, implement AgentSession abstraction"
```

---

## Chunk 3: WS Protocol + Handlers Update

Update the wire protocol and server-side message handlers to use `agent:*` event names and `AgentMessage` format.

### Task 9: Update `src/shared/ws-protocol.ts`

**Files:**
- Modify: `src/shared/ws-protocol.ts`

Rename `claude:*` → `agent:*`, replace `ClaudeMessage` with `AgentMessage`-based schema.

- [ ] **Step 1: Rewrite ws-protocol.ts**

Replace the Claude-specific schemas and message types. The key changes:
- `claudeSendSchema` → `agentSendSchema`
- `claudeStatusSchema` → `agentStatusSchema`
- `claudeMessageSchema` → `agentMessageSchema` (matches `AgentMessage` type)
- Client messages: `claude:send` → `agent:send`, `claude:stop` → `agent:stop`, `claude:status` → `agent:status`
- Server messages: `claude:message` → `agent:message`, `claude:status` → `agent:status`
- `session:history` uses `agentMessageSchema` array

The `agentMessageSchema` should be a Zod schema that validates the `AgentMessage` shape:

```ts
// Replace the "Claude schemas" section with:

// ── Agent schemas ───────────────────────────────────────────────────────
export const agentSendSchema = z.object({
  cardId: z.number(),
  message: z.string(),
  files: z.array(fileRefSchema).optional(),
})

export const agentStatusSchema = z.object({
  cardId: z.number(),
  active: z.boolean(),
  status: z.enum(['starting', 'running', 'completed', 'errored', 'stopped']),
  sessionId: z.string().nullable(),
  promptsSent: z.number(),
  turnsCompleted: z.number(),
})

export const agentMessageSchema = z.object({
  type: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  toolCall: z.object({
    id: z.string(),
    name: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  toolResult: z.object({
    id: z.string(),
    output: z.string(),
    isError: z.boolean().optional(),
  }).optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    contextWindow: z.number().optional(),
  }).optional(),
  modelUsage: z.record(z.string(), z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    costUSD: z.number(),
    contextWindow: z.number().optional(),
  })).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.number(),
})

export type AgentStatus = z.infer<typeof agentStatusSchema>
export type AgentMessage = z.infer<typeof agentMessageSchema>
```

In the `clientMessage` discriminated union, replace:
- `claude:send` → `agent:send` with `agentSendSchema`
- `claude:stop` → `agent:stop`
- `claude:status` → `agent:status`

In the `serverMessage` discriminated union, replace:
- `claude:message` → `agent:message` with `agentMessageSchema`
- `claude:status` → `agent:status` with `agentStatusSchema`
- `session:history` messages array uses `agentMessageSchema`

In `serverMessage`, also update the `session:history` entry:
```ts
z.object({ type: z.literal('session:history'), requestId: z.string(), cardId: z.number(), messages: z.array(agentMessageSchema) }),
```

Remove old `claudeSendSchema`, `claudeStatusSchema`, `claudeMessageSchema`, `ClaudeStatus`, `ClaudeMessage` exports.

- [ ] **Step 2: Commit**

```bash
git add src/shared/ws-protocol.ts
git commit -m "refactor: rename WS protocol claude:* → agent:*, use AgentMessage schema"
```

### Task 10: Create `src/server/ws/handlers/agents.ts`

**Files:**
- Create: `src/server/ws/handlers/agents.ts` (from `handlers/claude.ts`)
- Delete: `src/server/ws/handlers/claude.ts`

- [ ] **Step 1: Create agents.ts**

Update imports to use new paths, update `ClientMessage` extract types to use `agent:*`:

```ts
import { resolve } from 'path'
import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import { db } from '../../db/index'
import { cards } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { sessionManager } from '../../agents/manager'
import { beginSession } from '../../agents/begin-session'
import type { SessionStatus } from '../../agents/types'

export async function handleAgentSend(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:send' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId, message, files } } = msg
  console.log(`[session:${cardId}] agent:send received, message length=${message.length}, files=${files?.length ?? 0}`)

  try {
    const existing = db.select().from(cards).where(eq(cards.id, cardId)).get()
    if (!existing) throw new Error(`Card ${cardId} not found`)

    if (existing.column !== 'running') {
      if (!existing.title?.trim()) throw new Error('Title is required for running')
      if (!existing.description?.trim()) throw new Error('Description is required for running')
      mutator.updateCard(cardId, { column: 'running' })
    }

    let prompt = message
    if (files?.length) {
      for (const f of files) {
        if (!resolve(f.path).startsWith('/tmp/orchestrel-uploads/')) {
          throw new Error(`Invalid file path: ${f.path}`)
        }
      }
      const fileList = files.map((f) => `- ${f.path} (${f.name}, ${f.mimeType})`).join('\n')
      prompt = `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${prompt}`
    }

    await beginSession(cardId, prompt, ws, connections, mutator)
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`[session:${cardId}] agent:send error:`, error)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

export async function handleAgentStop(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:stop' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId } } = msg
  console.log(`[session:${cardId}] agent:stop received`)

  try {
    await sessionManager.kill(cardId)
    mutator.updateCard(cardId, { column: 'review' })
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`[session:${cardId}] agent:stop error:`, error)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

export async function handleAgentStatus(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'agent:status' }>,
  connections: ConnectionManager,
  _mutator: DbMutator,
): Promise<void> {
  const { requestId, data: { cardId } } = msg

  try {
    const session = sessionManager.get(cardId)

    let statusData: {
      cardId: number
      active: boolean
      status: SessionStatus
      sessionId: string | null
      promptsSent: number
      turnsCompleted: number
    }

    if (session) {
      statusData = {
        cardId,
        active: session.status === 'running',
        status: session.status,
        sessionId: session.sessionId,
        promptsSent: session.promptsSent,
        turnsCompleted: session.turnsCompleted,
      }
    } else {
      const card = db.select({
        promptsSent: cards.promptsSent,
        turnsCompleted: cards.turnsCompleted,
        sessionId: cards.sessionId,
      }).from(cards).where(eq(cards.id, cardId)).get()

      statusData = {
        cardId,
        active: false,
        status: 'completed',
        sessionId: card?.sessionId ?? null,
        promptsSent: card?.promptsSent ?? 0,
        turnsCompleted: card?.turnsCompleted ?? 0,
      }
    }

    connections.send(ws, { type: 'agent:status', data: statusData })
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}
```

- [ ] **Step 2: Delete old handler**

```bash
rm src/server/ws/handlers/claude.ts
```

### Task 11: Update `src/server/ws/handlers/sessions.ts`

**Files:**
- Modify: `src/server/ws/handlers/sessions.ts`

Key changes:
- Import from `../../agents/` paths
- Normalize history messages to `AgentMessage[]` using `normalizeClaudeMessage`
- Update tailer messages to use `normalizeClaudeMessage`
- Send `agent:message` and `agent:status` instead of `claude:*`

- [ ] **Step 1: Rewrite sessions.ts**

Replace the full file. The main structural changes:
1. Import `normalizeClaudeMessage` and `normalizeToolResult` from `../../agents/claude/messages`
2. Import `sessionManager` from `../../agents/manager`
3. Import `getSDKSessionPath` from `../../agents/claude/session-path`
4. Import `AgentMessage` from `../../agents/types`
5. `injectTurnDividers` stays the same (operates on raw JSONL)
6. After filtering, normalize each raw message through `normalizeClaudeMessage`
7. Also extract `tool_result` blocks from user messages as standalone `AgentMessage` events
8. Tailer messages go through `normalizeClaudeMessage` before sending
9. All `claude:message` → `agent:message`, `claude:status` → `agent:status`

The critical normalization happens after `injectTurnDividers` and `filter`:

```ts
// After filtered = withDividers.filter(...)
const normalized: AgentMessage[] = []
for (const m of filtered) {
  normalized.push(...normalizeClaudeMessage(m))
  // Also extract tool_result blocks from user messages
  if (m.type === 'user') {
    const inner = m.message as { content?: unknown } | undefined
    if (Array.isArray(inner?.content)) {
      for (const block of inner!.content as Array<Record<string, unknown>>) {
        const tr = normalizeToolResult(block as { type: string; tool_use_id?: string; content?: unknown }, Date.now())
        if (tr) normalized.push(tr)
      }
    }
  }
}
messages = normalized
```

For the tailer:
```ts
tailer.on('message', (rawMsg: Record<string, unknown>) => {
  const agentMsgs = normalizeClaudeMessage(rawMsg)
  for (const am of agentMsgs) {
    connections.send(ws, { type: 'agent:message', cardId, data: am })
  }
})
```

- [ ] **Step 2: Commit**

### Task 12: Update `src/server/ws/handlers.ts`

**Files:**
- Modify: `src/server/ws/handlers.ts`

- [ ] **Step 1: Update imports and case labels**

Replace:
```ts
import {
  handleClaudeSend,
  handleClaudeStop,
  handleClaudeStatus,
} from './handlers/claude'
```
With:
```ts
import {
  handleAgentSend,
  handleAgentStop,
  handleAgentStatus,
} from './handlers/agents'
```

Replace case labels:
```ts
case 'agent:send':
  void handleAgentSend(ws, msg, connections, mutator)
  break
case 'agent:stop':
  void handleAgentStop(ws, msg, connections, mutator)
  break
case 'agent:status':
  void handleAgentStatus(ws, msg, connections, mutator)
  break
```

Remove the old `claude:send`, `claude:stop`, `claude:status` cases.

- [ ] **Step 2: Commit all WS changes**

```bash
git add -A src/server/ws/ src/shared/ws-protocol.ts
git commit -m "refactor: rename WS handlers claude:* → agent:*, normalize session history"
```

---

## Chunk 4: Client Stores Update

### Task 13: Update `app/stores/session-store.ts`

**Files:**
- Modify: `app/stores/session-store.ts`

Key changes:
- Import `AgentMessage`, `AgentStatus` instead of `ClaudeMessage`, `ClaudeStatus`
- `ConversationRow` changes: `type` field expands to include `AgentMessage` types, `message` field removed (data is flat on the row)
- `ingest()` takes `AgentMessage` and stores it directly
- `ingestBatch()` takes `AgentMessage[]`
- Context tracking: reads from `usage` field on `text` type messages, `contextWindow` from `turn_end` `usage`
- `handleClaudeStatus` → `handleAgentStatus`
- `sendMessage` sends `agent:send`, `stopSession` sends `agent:stop`, `requestStatus` sends `agent:status`

- [ ] **Step 1: Rewrite session-store.ts**

The `ConversationRow` becomes simpler — it's essentially `AgentMessage` with an `id` for dedup:

```ts
export interface ConversationRow extends AgentMessage {
  id: string  // content hash for dedup
}
```

The `ingest` method hashes the AgentMessage for dedup. **Important:** exclude `timestamp` from the hash — it uses `Date.now()` during normalization, so the same raw JSONL line normalized at different times (history load vs live stream) would produce different hashes and break dedup. Hash on `type` + stable content fields only:

```ts
ingest(cardId: number, msg: AgentMessage): void {
  runInAction(() => {
    const s = this.getOrCreate(cardId)
    // Exclude timestamp from hash — it varies between history load and live stream
    const { timestamp, ...stable } = msg
    const id = contentHashSync(msg.type, stable)
    if (s.conversationIds.has(id)) return
    s.conversation.push({ ...msg, id })
    s.conversationIds.add(id)

    // Context tracking from text messages with usage
    if (msg.type === 'text' && !msg.meta?.isSidechain && msg.usage) {
      const u = msg.usage
      s.contextTokens = u.inputTokens + (u.cacheWrite ?? 0) + (u.cacheRead ?? 0)
    }
    // Context window from turn_end
    if (msg.type === 'turn_end' && msg.usage?.contextWindow) {
      s.contextWindow = msg.usage.contextWindow
    }
  })
}
```

Update `sendMessage`, `stopSession`, `requestStatus` to use `agent:*` message types.

- [ ] **Step 2: Commit**

### Task 14: Update `app/stores/root-store.ts`

**Files:**
- Modify: `app/stores/root-store.ts`

- [ ] **Step 1: Update message routing**

Replace:
```ts
case 'claude:message':
  this.sessions.ingest(msg.cardId, msg.data)
  break
case 'claude:status':
  this.sessions.handleClaudeStatus(msg.data)
  break
```
With:
```ts
case 'agent:message':
  this.sessions.ingest(msg.cardId, msg.data)
  break
case 'agent:status':
  this.sessions.handleAgentStatus(msg.data)
  break
```

Update import to use `AgentMessage`, `AgentStatus` from ws-protocol.

- [ ] **Step 2: Commit**

```bash
git add app/stores/
git commit -m "refactor: update client stores for agent:* protocol and AgentMessage format"
```

---

## Chunk 5: Frontend Components

### Task 15: Rewrite `app/components/MessageBlock.tsx`

**Files:**
- Modify: `app/components/MessageBlock.tsx`

The current `MessageBlock` receives a Claude-native message shape and internally dispatches to `AssistantBlock` (which iterates over content arrays), `ResultBlock`, `SystemBlock`, `UserBlock`, etc.

In the new model, each `AgentMessage` is a single block — no content array iteration needed. The dispatch is by `AgentMessage.type`:

- `text` → Markdown text (was part of `AssistantBlock`)
- `tool_call` → `ToolUseBlock` with output from `toolOutputs` map
- `tool_result` → Not rendered directly (consumed by `toolOutputs` map)
- `tool_progress` → Animated dot + tool name + elapsed time (was `ToolProgressBlock`)
- `thinking` → Collapsible thinking block
- `system` → System message (init, compact_boundary, etc.)
- `turn_end` → Turn divider with cost/duration (was `ResultBlock`)
- `user` → User bubble
- `error` → Error display

- [ ] **Step 1: Rewrite MessageBlock**

The component signature changes:
```ts
type Props = {
  message: AgentMessage & { id: string }
  toolOutputs: Map<string, string>
  accentColor?: string | null
}
```

Key implementation details:
- `TextBlock`: Renders `message.content` as Markdown. Shows `CopyButton`. Preserves accent-colored links.
- `ToolCallBlock`: Uses `ToolUseBlock` component (unchanged). Gets `toolCall.name`, `toolCall.params`, output from `toolOutputs.get(toolCall.id)`.
- `ThinkingBlock`: Unchanged (renders `message.content`).
- `SystemBlock`: Reads `message.meta.subtype` for init/compact_boundary/local_command_output.
- `TurnEndBlock` (was `ResultBlock`): Reads cost from `message.modelUsage`, duration from `message.meta.durationMs`, timestamp from `message.timestamp`.
- `UserBlock`: Renders `message.content`. File attachment detection stays the same (text pattern matching).
- `tool_result` type: Return `null` (invisible — only consumed by toolOutputs).

The `MODEL_PRICING` table, `calcCostFromModelUsage`, `Markdown`, `CopyButton`, `ThinkingBlock`, and `ToolProgressBlock` stay the same. `mdComponents` stays the same.

- [ ] **Step 2: Commit**

### Task 16: Update `app/components/SessionView.tsx`

**Files:**
- Modify: `app/components/SessionView.tsx`

- [ ] **Step 1: Update toolOutputs memo**

The current `toolOutputs` memo scans user messages for `tool_result` content blocks. In the new model, tool results are standalone `AgentMessage` events with `type: 'tool_result'`:

```ts
const toolOutputs = useMemo(() => {
  const map = new Map<string, string>()
  for (const row of conversation) {
    if (row.type !== 'tool_result' || !row.toolResult) continue
    if (row.toolResult.output) {
      map.set(row.toolResult.id, row.toolResult.output)
    }
  }
  return map
}, [conversation.length])
```

- [ ] **Step 2: Update MessageBlock props**

The `MessageBlock` now receives the row directly (which is `AgentMessage & { id: string }`):

```tsx
{conversation.map((row) => (
  <MessageBlock
    key={row.id}
    message={row}
    toolOutputs={toolOutputs}
    accentColor={accentColor}
  />
))}
```

- [ ] **Step 3: Update compaction detection**

Current check: `last.type === 'system' && last.message.subtype === 'compact_boundary'`
New check: `last.type === 'system' && last.meta?.subtype === 'compact_boundary'`

- [ ] **Step 4: Commit**

```bash
git add app/components/
git commit -m "refactor: rewrite MessageBlock and SessionView for AgentMessage format"
```

---

## Chunk 6: DB Migration + Project Settings

> **Note:** `beginSession` in Chunk 2 reads `proj.agentType` which won't exist in the DB until this migration runs. The code uses `(proj.agentType as 'claude' | 'kiro') ?? 'claude'` which safely defaults to `'claude'` when the column is missing. Run this migration as soon as Chunk 2 lands — before the first manual smoke test.

### Task 17: Update schema and create migration

**Files:**
- Modify: `src/server/db/schema.ts`

- [ ] **Step 1: Add fields to projects table**

Add after `defaultThinkingLevel`:
```ts
agentType: text('agent_type', { enum: ['claude', 'kiro'] }).notNull().default('claude'),
agentProfile: text('agent_profile'),
```

- [ ] **Step 2: Generate and run migration**

```bash
npx drizzle-kit generate
npx drizzle-kit push
```

- [ ] **Step 3: Update ws-protocol.ts project schemas**

The `projectCreateSchema` and `projectUpdateSchema` need to include the new fields. Add to `projectCreateSchema.pick()`:
```ts
agentType: true,
agentProfile: true,
```

- [ ] **Step 4: Commit**

```bash
git add src/server/db/ src/shared/ws-protocol.ts
git commit -m "feat: add agentType and agentProfile to projects table"
```

### Task 18: Verify full compilation and test

- [ ] **Step 1: TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: Clean compile (or only pre-existing warnings)

- [ ] **Step 2: Manual smoke test**

Restart the service and verify:
1. Board loads correctly
2. Existing sessions display history
3. New session starts and streams output
4. Stop button works
5. Session resumes after follow-up message

```bash
sudo systemctl restart orchestrel
```

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: resolve compilation and runtime issues from multi-agent refactor"
```
