# OpenCode Migration Design

**Date:** 2026-03-13
**Status:** Approved
**Supersedes:** Multi-agent abstraction (2026-03-12), Kiro agent integration (2026-03-13)

## Summary

Replace both agent providers (Claude SDK, Kiro ACP) with a single OpenCode backend. Dispatcher becomes a kanban UI and session orchestrator over OpenCode's agent layer. One `opencode serve` process handles all model providers, session management, tool execution, and MCP integration.

## Motivation

- Kiro CLI is painful to integrate — poor compaction support (summarize + new session), fragile ACP protocol, stdio parsing headaches
- Maintaining two divergent agent protocol integrations (and dreading adding more) is a real cost
- OpenCode supports 75+ model providers through a single interface, including Anthropic (Claude) and Kiro
- OpenCode handles context compaction, tool execution, MCP — all the agent plumbing Dispatcher currently reimplements per provider
- TUI interop: users can `opencode attach` to interact with the same sessions directly

## Architecture

### OpenCode Server Lifecycle

Dispatcher spawns `opencode serve` as a child process on startup:

- **Port:** 4097 (configurable)
- **Config:** `data/opencode.json`
- **Startup validation:** Verify `opencode` binary is on PATH before spawning. Log a clear error and exit if missing.
- **Process management:** Monitor child process, restart on unexpected exit with exponential backoff (1s/2s/4s/8s, max 5 retries). On max retries exhausted, log error and mark server as unavailable.
- **Health check:** Poll `/api/health` on startup until ready
- **Crash recovery:** When the OpenCode process dies unexpectedly, emit error to all active session subscribers, mark affected cards as `errored`. On successful restart, sessions are recoverable from OpenCode's persisted SQLite DB.
- **Shutdown:** Abort active sessions, kill process on SIGTERM
- **SDK client:** Single shared `createOpencodeClient({ baseUrl: 'http://localhost:4097' })` instance

**Module:** `src/server/opencode/server.ts`

### Providers

Three providers configured in `data/opencode.json`:

| Provider ID | Billing | Auth |
|---|---|---|
| `anthropic` | Ryan's personal Anthropic account | API key |
| `kiro-okkanti` | Okkanti project (Kiro account) | opencode-kiro-auth plugin |
| `kiro-trackable` | Trackable project (Kiro account) | opencode-kiro-auth plugin |

Projects in Dispatcher store a `providerID` that maps to one of these.

### Kiro Auth Plugin

**External dependency** — not part of Dispatcher codebase.

Fork of [opencode-kiro-auth](https://github.com/tickernelz/opencode-kiro-auth) with one enhancement: support multiple named instances with isolated credential storage, driven by config rather than hardcoded single export.

Each instance gets its own provider ID, account DB, and `AccountManager`. The existing `createKiroPlugin(id)` factory already supports this — the fork makes it config-driven.

### Model Selection

**UI:** Two fields on cards (unchanged):
- Model: sonnet / opus
- Thinking level: off / low / medium / high

**Backend mapping:** Dispatcher combines `project.providerID` + `card.model` + `card.thinkingLevel` into `{ providerID, modelID }` for the SDK call.

Example: `kiro-okkanti` + `opus` + `high` → `{ providerID: "kiro-okkanti", modelID: "claude-opus-4-6-thinking" }`

**Model definitions:** 3 providers x 2 models x 4 thinking levels = 12 entries in `data/opencode.json`, configured with appropriate `thinking.budgetTokens` per variant.

**Model switching mid-session:** OpenCode's `session.prompt()` accepts a `model` param per call. If the user changes model or thinking level between turns, the next `sendMessage()` call passes the updated `{ providerID, modelID }`. No new session required.

**Mapping helper:** `src/server/agents/opencode/models.ts`

```
resolveModelID(model: 'sonnet' | 'opus', thinkingLevel: 'off' | 'low' | 'medium' | 'high'): string
```

### Per-Session Working Directory

Each SDK call includes `?directory=/path/to/worktree` query param (or `x-opencode-directory` header) to scope the session's tool execution to the card's worktree. The OpenCode server supports this natively.

### MCP Configuration

- **Global:** Shared-memory MCP configured in `data/opencode.json`
- **Per-project:** Each project's directory can contain its own `opencode.json` with project-specific MCP servers
- **Dispatcher responsibility:** None. MCP is fully delegated to OpenCode.

### Session History

Use OpenCode SDK exclusively:
- **Live streaming:** SSE subscription via `client.event.subscribe()`, scoped to session. Events normalized to `AgentMessage` and forwarded to WS subscribers.
- **History replay:** `client.session.messages(id)` returns the full message list for a session. Each message is normalized to `AgentMessage` format before sending to the client.
- **No file tailing, no Dispatcher DB duplication.** All Claude/Kiro-specific log parsing, JSONL reading, and file tailing is eliminated.

### Session Resume

OpenCode persists sessions in its own SQLite DB. After Dispatcher restart:
1. Child OpenCode process restarts, DB persists
2. Cards with `sessionId` reconnect to existing OpenCode sessions
3. `session.get(id)` verifies session exists, `session.prompt()` sends follow-ups

## OpenCodeSession Implementation

**Module:** `src/server/agents/opencode/session.ts`

Extends `AgentSession`:

- `constructor(client, cwd, providerID, modelID, resumeSessionId?)`
- `start(prompt)` — Create session with `?directory=cwd`, send initial prompt, subscribe to SSE
- `sendMessage(content)` — Send follow-up prompt to existing session (re-resolves modelID from current card state to support mid-session model changes)
- `kill()` — `client.session.abort(id)`, emit exit
- `waitForReady()` — Resolve once `session.create()` returns with session ID

**Event normalization:** `src/server/agents/opencode/messages.ts`

Maps OpenCode SSE events to `AgentMessage` types:
- `message.part` (type: text) → `AgentMessage` type `text` (role: assistant)
- `message.part` (type: tool-invocation) → `AgentMessage` type `tool_call`
- `message.part` (type: tool-result) → `AgentMessage` type `tool_result`
- `message.part` (type: thinking) → `AgentMessage` type `thinking`
- End of assistant response (no more tool calls) → `AgentMessage` type `turn_end`, increment `turnsCompleted`
- Errors → `AgentMessage` type `error`

**Counter tracking:** `promptsSent` incremented on each `start()` / `sendMessage()` call. `turnsCompleted` incremented when the assistant completes a full response cycle (no pending tool calls). Derived from SSE event flow, not from OpenCode metadata.

**`queryStartIndex`:** Removed from `AgentSession`. OpenCode SSE handles deduplication natively.

## Factory & Session Options

**Updated `CreateSessionOpts`:**

```typescript
interface CreateSessionOpts {
  cwd: string
  providerID: string
  model: 'sonnet' | 'opus'
  thinkingLevel: 'off' | 'low' | 'medium' | 'high'
  resumeSessionId?: string
  projectName?: string
}
```

`agentType`, `agentProfile` removed. `providerID` replaces `agentType` for routing. `model` + `thinkingLevel` stay as-is; `resolveModelID()` is called inside the factory or `OpenCodeSession` constructor to produce the final `modelID` string.

**Factory:** Single case (no switch needed with one provider, but keep the structure):

```typescript
case 'opencode':
  const modelID = resolveModelID(opts.model, opts.thinkingLevel)
  return new OpenCodeSession(openCodeServer.client, opts.cwd, opts.providerID, modelID, opts.resumeSessionId)
```

## begin-session.ts Rewrite

Simplified flow:

```
beginSession(cardId, message, ws, connections, mutator):
  1. Load card from DB
  2. Check for existing session in SessionManager
     - If exists: subscribe WS, sendMessage(message), update counters, return
  3. New session:
     a. Resolve worktree path (ensureWorktree — unchanged)
     b. Load project → read project.providerID (replaces agentType/agentProfile resolution)
     c. Create session via sessionManager.create(cardId, {
          cwd, providerID, model: card.model, thinkingLevel: card.thinkingLevel,
          resumeSessionId: card.sessionId, projectName
        })
     d. Restore counters from DB if resuming
     e. Subscribe WS to session
     f. session.start(prompt)
     g. await session.waitForReady()
     h. Persist sessionId to card DB
     i. Send agent:status to WS
```

All Kiro tailer wiring, Claude-specific imports, and agentType/agentProfile branching removed.

## Session History Handler Migration

**Current:** `src/server/ws/handlers/sessions.ts` (259 lines) — Claude JSONL parsing, Kiro JSONL parsing, turn divider injection, file tailing for external sessions, legacy fallback paths.

**New:** Replace entirely with SDK-based loading:

```
handleSessionLoad(sessionId, ws, connections):
  1. client.session.get(sessionId) — verify session exists
  2. client.session.messages(sessionId) — fetch full message history
  3. Normalize each message via normalizeOpenCodeEvent()
  4. Send to WS client as agent:message events
```

All Claude/Kiro-specific imports removed: `getSDKSessionPath`, `getKiroSessionLogPath`, `normalizeClaudeMessage`, `normalizeToolResult`, etc.

File tailing for externally-active sessions is eliminated — sessions started via TUI (`opencode attach`) are visible through the same SDK, so `session.messages()` returns their history and SSE provides live updates.

## Schema Changes

**Projects table:**
- Add: `providerID` column (`'anthropic' | 'kiro-okkanti' | 'kiro-trackable'`, default `'anthropic'`)
- Remove: `agentType`, `agentProfile`

**Cards table:** No schema changes. `model`, `thinkingLevel`, `sessionId` all stay.

**AgentSession base class:** Remove `queryStartIndex` field.

**Types:** `AgentType = 'opencode'`

**Migration:**
1. Backup `data/dispatcher.db` to `data/dispatcher.db.backup`
2. Delete all existing cards (intentional clean slate — old sessions are Claude/Kiro and won't resolve against OpenCode's DB)
3. Schema migration: add `providerID`, drop `agentType`/`agentProfile`
4. Update existing project rows with appropriate `providerID`

## Code Deletion

**Remove entirely:**
- `src/server/agents/claude/` — `session.ts`, `messages.ts`, `session-path.ts`
- `src/server/agents/kiro/` — `session.ts`, `messages.ts`, `session-path.ts`, `tailer.ts`
- `src/server/agents/tailer.ts`

**Simplify:**
- `src/server/agents/begin-session.ts` — Rewritten per flow above. All Claude/Kiro-specific imports removed.
- `src/server/ws/handlers/sessions.ts` — Rewritten per Session History Handler Migration above. All Claude/Kiro-specific imports removed (`getSDKSessionPath`, `getKiroSessionLogPath`, `normalizeClaudeMessage`, `normalizeToolResult`, etc.).
- `src/server/agents/manager.ts` — Remove tailer management (`startTailing`, `getTailer`, `stopTailing`, tailers Map)

**Dependencies:**
- Remove: `@anthropic-ai/claude-agent-sdk`
- Add: `@opencode-ai/sdk`

**Estimated net change:** Delete ~1500 lines, add ~300 lines.

## Frontend Changes

**ProjectForm.tsx:**
- Replace `agentType` dropdown with `providerID` dropdown (Anthropic / Kiro-Okkanti / Kiro-Trackable)
- Remove Kiro HOME directory picker (`DirectoryBrowser`, `agentProfile` field)

**SessionView.tsx:**
- Minimal changes — already renders `AgentMessage` from WS subscription
- History loading calls backend endpoint that uses `session.messages(id)`

**Card model selection:** No changes — two fields (model, thinking level) stay as-is.

**Remove:** Kiro-specific UI conditionals, DirectoryBrowser (if only used for Kiro).

## Deployment

**Systemd service:** No change — `dispatcher.service` runs `pnpm dev` on port 6194. OpenCode is a child process.

**OpenCode binary:** Must be on PATH. Install globally via npm or pin path.

**Shell alias:** `alias oc="opencode attach http://localhost:4097"` for TUI access.

**Cloudflare tunnel:** No change — only Dispatcher's port 6194 is exposed.

## TUI Interop

Users can `opencode attach http://localhost:4097` to interact with the same sessions via OpenCode's terminal UI. Sessions started in TUI are visible to Dispatcher (future: import orphan sessions into cards).

## Risks

- **Quality regression:** If OpenCode's abstraction over Anthropic models produces lower quality output than the direct Claude SDK, the `AgentSession` abstraction allows bringing back a `ClaudeSession` alongside `OpenCodeSession`.
- **OpenCode dependency:** Core agent functionality depends on an open-source project. Mitigated by: large community (70k stars), active development, forkable if needed.
- **SSE event fidelity:** OpenCode's SSE events may not expose all the granularity of Claude SDK output (cache tokens, context window tracking). Verify during implementation.
- **Per-session directory support:** Confirmed working via `?directory=` query param, but needs integration testing with the TypeScript SDK client.
