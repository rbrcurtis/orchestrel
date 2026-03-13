# Multi-Agent Abstraction Design

## Overview

Refactor dispatcher's Claude Code integration into an abstract agent service that supports multiple AI coding agents (Claude Code, Kiro, and future agents). Phase 1 extracts the abstraction and refactors Claude into it. Phase 2 (separate) adds Kiro implementation.

## Motivation

Ryan is switching work AI agent to Kiro (has 2 AWS jobs = 2 Kiro accounts). Dispatcher needs to orchestrate both Claude Code and Kiro sessions from the same board, with agent selection per-project.

## Data Model Changes

### Projects table

Two new fields:

- `agentType`: `'claude' | 'kiro'` — default `'claude'`
- `agentProfile`: nullable string — for Kiro, the profile name (e.g., `"job1"`) mapping to a HOME directory for auth isolation. Null for Claude. Hidden in UI until Phase 2.

### Cards table

No changes. Cards inherit agent config from their project. Existing `model`, `thinkingLevel`, `sessionId` fields work for both agents.

### Shared type

Export `AgentType = 'claude' | 'kiro'` from `agents/types.ts`, used by both DB schema and factory to prevent drift.

## Unified Message Format

Each agent turn emits multiple `AgentMessage` events — one per logical block. An assistant turn with text + tool_call becomes two separate messages. This matches how streaming naturally works and avoids needing structured content arrays.

```ts
type AgentMessage = {
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'system' | 'turn_end' | 'error'
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
  timestamp: number
}
```

### Claude SDK mapping

- Assistant text blocks → `type: 'text'`
- Assistant tool_use blocks → `type: 'tool_call'` (one message per block)
- Tool result blocks → `type: 'tool_result'` (one message per block)
- Thinking blocks → `type: 'thinking'`
- Result messages → `type: 'turn_end'` (carries `usage` with `contextWindow`)
- System init → `type: 'system'`

### Kiro ACP mapping (Phase 2)

- `AgentMessageChunk` → `type: 'text'`
- `ToolCall` → `type: 'tool_call'`
- `ToolCallUpdate` → `type: 'tool_result'`
- `TurnEnd` → `type: 'turn_end'`

## Abstract Agent Interface

```ts
abstract class AgentSession extends EventEmitter {
  abstract sessionId: string | null
  abstract status: 'starting' | 'running' | 'completed' | 'errored' | 'stopped'
  abstract promptsSent: number
  abstract turnsCompleted: number

  // Optional agent capabilities — set by concrete implementations
  model?: string
  thinkingLevel?: string

  abstract start(prompt: string): Promise<void>
  abstract sendMessage(content: string): Promise<void>
  abstract kill(): Promise<void>
  abstract waitForReady(): Promise<void>

  // Events:
  //   'message' → AgentMessage
  //   'exit' → { status, error? }
}
```

### Key interface decisions

- **`kill()` is async** — Claude needs to `await interrupt()`, Kiro needs to send `session/cancel` then kill the process.
- **`waitForReady()`** replaces the Claude-specific `waitForInit()`. Claude impl waits for `sessionId` from system init message. Kiro impl (Phase 2) waits for `initialize` JSON-RPC response.
- **`sendMessage()`** replaces current `sendUserMessage()` — all call sites in `begin-session.ts` updated.
- **`model` and `thinkingLevel`** are optional properties on the abstract class (both agents support model selection). `beginSession()` can set them without casting.

### Factory

```ts
function createAgentSession(opts: {
  agentType: AgentType
  agentProfile?: string
  cwd: string
  model?: string
  thinkingLevel?: string
  sessionId?: string // for resume
  projectName?: string
}): AgentSession
```

## ClaudeSession (Phase 1 refactor)

Existing `ClaudeSession` refactored to extend `AgentSession`:

- `handleMessage()` splits SDK content arrays into individual `AgentMessage` events (one per text block, tool_use block, thinking block)
- `waitForReady()` waits for `sessionId` to be non-null (from system init message), 30s timeout
- `sendUserMessage()` renamed to `sendMessage()`
- `kill()` signature changed to `async`

## KiroSession (Phase 2, not implemented in Phase 1)

- Spawns `kiro-cli acp` via `child_process.spawn()` with `HOME` set to `/home/ryan/.kiro-profiles/<profileName>/` for auth isolation
- JSON-RPC 2.0 communication over stdio
- `waitForReady()` waits for `initialize` response
- Maps ACP `session/notification` events to `AgentMessage`
- Fallback if HOME isolation fails: Docker sandbox per account

## SessionManager

Becomes agent-agnostic. Works with `AgentSession` instances. Uses factory for creation instead of directly instantiating `ClaudeSession`.

## beginSession()

Reads project `agentType` and `agentProfile`, passes to factory. Calls `session.waitForReady()` instead of the Claude-specific `waitForInit()`. All downstream logic (handler registration, card state transitions, counter persistence) works against the abstract `AgentSession` interface.

## Session History

Existing handler in `src/server/ws/handlers/sessions.ts` gets a normalization pass. Raw Claude JSONL → `AgentMessage[]` conversion before emitting to client. Phase 1: only Claude history normalization. Phase 2 adds Kiro JSONL normalization.

The `SessionTailer` (for external CLI sessions) moves to `agents/tailer.ts` unchanged — it already emits raw JSONL lines. The handler that consumes tailer events adds the same normalization.

## WebSocket Protocol

Event names change from Claude-specific to agent-agnostic:

- `claude:send` → `agent:send`
- `claude:stop` → `agent:stop`
- `claude:message` → `agent:message`
- `claude:status` → `agent:status`

All client-side references updated: session store, `SessionView`, `CardDetail`, etc.

## Frontend

### SessionView

`MessageBlock` component rewritten to render `AgentMessage` types:
- `text` → rendered text (markdown)
- `tool_call` → tool name + params display
- `tool_result` → collapsible output
- `thinking` → collapsible thinking block
- `turn_end` → turn divider with usage stats
- `error` → error display

The `toolOutputs` memo reconstructed from paired `tool_call` / `tool_result` messages (matched by `toolCall.id` / `toolResult.id`) instead of nested content arrays.

### Project settings

Agent type selector added. `agentProfile` field hidden until Phase 2.

## File Organization

### New files

- `src/server/agents/types.ts` — `AgentType`, `AgentMessage`, `AgentSession` abstract class, factory types
- `src/server/agents/factory.ts` — `createAgentSession()` factory
- `src/server/agents/claude/session.ts` — refactored ClaudeSession (from `src/server/claude/protocol.ts`)
- `src/server/agents/claude/messages.ts` — Claude SDK → AgentMessage normalization

### Moved/refactored

- `src/server/claude/manager.ts` → `src/server/agents/manager.ts`
- `src/server/claude/begin-session.ts` → `src/server/agents/begin-session.ts`
- `src/server/claude/tailer.ts` → `src/server/agents/tailer.ts`

### Updated

- `src/server/db/schema.ts` — add `agentType`, `agentProfile` to projects
- `src/server/ws/handlers/claude.ts` → rename to `agents.ts`, update event names
- `src/server/ws/handlers/sessions.ts` — normalize history to AgentMessage[]
- `app/components/SessionView.tsx` — render AgentMessage via rewritten MessageBlock
- Client session store — update event names (`agent:*`)
- Project settings UI — agent type selector

### Deleted

- `src/server/claude/` directory (contents moved to `src/server/agents/claude/`)

## Phase Boundary

**Phase 1 (this spec):** Abstract interface, Claude refactored into it, data model changes, unified message format, WebSocket protocol rename, frontend updates. Only Claude agent exists.

**Phase 2 (separate spec):** KiroSession implementation, HOME isolation testing, ACP JSON-RPC client, Kiro message normalization, profile management UI.

## Backup Approaches (stored in shared memory)

- Session rendering: agent-specific renderers or hybrid format if unified proves insufficient
- Kiro integration: CLI non-interactive mode or Docker sandbox if ACP doesn't work well
- Kiro multi-auth: Docker sandbox if HOME isolation doesn't work
