# Kiro Agent Integration

## Overview

Add Kiro as a second agent type in Orchestrel. Projects can select Claude Code (default) or Kiro, with Kiro requiring a HOME directory for auth isolation. The directory browser component gets enhanced with typeahead filtering, paste support, and folder creation. KiroSession implements the ACP (Agent Client Protocol) over stdio. Log tailing and session replay round out feature parity with Claude.

## Implementation Stages

### Stage 1: Directory Browser Enhancements + ProjectForm Agent Fields

### Stage 2: KiroSession Class + Factory Hookup

### Stage 3: Kiro Log Tailing & Session Replay

---

## Stage 1: Directory Browser & ProjectForm

### Directory Browser Enhancements

The existing directory browser component gains three capabilities, shared by both the project path picker and the Kiro HOME picker.

**Typeahead filtering:** The path input filters the directory listing as the user types. Typing "OK" while browsing `/home/ryan/` narrows visible entries to those matching "OK". Navigating into a folder resets the filter. Clearing the input shows all entries.

**Paste support:** Pasting a full path into the input navigates directly to that directory. If the path exists and is a directory, browse into it. If it doesn't exist, allow selection anyway (for cases where the folder will be created).

**New Folder button:** A button in the directory listing. Clicking shows an inline text input prompting for the folder name, with confirm/cancel. On confirm, creates the directory via `projects.mkdir` tRPC procedure (input: `{ path: string }`, creates recursively, returns `{ success: boolean }`) and refreshes the listing. The new folder is created inside whatever directory is currently being browsed.

### Directory Browser Component Changes

The `DirectoryBrowser` `onSelect` callback currently passes `(path: string, isGitRepo: boolean)`. To support Kiro HOME (which has no git concept), make `isGitRepo` optional: `onSelect: (path: string, isGitRepo?: boolean)`. The project path picker continues to pass it; the Kiro HOME picker omits it.

### ProjectForm Agent Fields

Two new fields in ProjectForm, placed after the project path section:

1. **Agent Type** — Select dropdown: "Claude Code" (default), "Kiro". Stored as `agentType` on the project.

2. **Kiro HOME** — Directory picker (same enhanced component as project path). Only visible when agent type is "Kiro". Stored as `agentProfile` on the project. Label: "Kiro HOME" with hint text: "Auth & config directory for this Kiro instance".

**Validation:** When agent type is Kiro, `agentProfile` is required. When Claude Code, `agentProfile` is ignored and cleared.

**Form state changes:** Add `agentType` (default `'claude'`) and `agentProfile` (default `''`) to ProjectForm local state. Update `isValid` to: `name && path && (!isGitRepo || defaultBranch) && (agentType !== 'kiro' || agentProfile)`. The `Project` interface used for edit mode already includes these fields from the DB schema. When switching from Kiro back to Claude Code, clear `agentProfile`.

**Existing support:** The DB schema (`agentType`, `agentProfile` columns), project store, WS protocol schemas, and `begin-session.ts` already read and pass these fields through. Only the form UI is new.

---

## Stage 2: KiroSession + Factory

### KiroSession Class

`KiroSession` extends `AgentSession` in `src/server/agents/kiro/session.ts`.

Spawns `kiro-cli acp` over stdio with `HOME` set to the `agentProfile` path and `cwd` set to the project path. Communicates via JSON-RPC 2.0 on stdin/stdout.

**Constructor:** `constructor(cwd: string, agentProfile: string, resumeSessionId?: string)`

**Lifecycle:**

- `start(prompt)` — Spawn child process with `{ env: { ...process.env, HOME: agentProfile }, cwd }`. Send `initialize` JSON-RPC request. On response, extract `sessionId` from the initialize result (likely `result.sessionId` or from the subsequent `session/new` response — exact field TBD during implementation by inspecting ACP output). Then send `session/new` for new sessions, or `session/load` if `resumeSessionId` is set. Finally, send `session/prompt` with `prompt`. On resume, `prompt` is the new follow-up message (not the original card prompt) — the caller is responsible for providing the right prompt for the context.
- `sendMessage(text)` — Send `session/prompt` JSON-RPC request with additional prompts (after the first).
- `kill()` — Guard against already-exited process or pre-init state. If the process is running, send `session/cancel` (ignoring EPIPE), then kill the child process. If already exited, no-op.
- `waitForReady()` — Wait for `sessionId` to be captured (30s timeout, same pattern as ClaudeSession). Called by `SessionManager` after `start()` returns and before the tailer begins — the tailer needs `sessionId` for path resolution. Sequence: `start()` → `waitForReady()` → tailer starts.

### Message Normalization

`src/server/agents/kiro/messages.ts` — `normalizeKiroMessage()` maps ACP notification events to `AgentMessage`:

| ACP Event | AgentMessage type | Key fields to extract |
|---|---|---|
| `AgentMessageChunk` | `text` | `chunk.content` → message text |
| `ToolCall` | `tool_call` | `toolName`, `toolCallId`, `input` (params) |
| `ToolCallUpdate` | `tool_progress` | `toolCallId`, `content` (partial output) |
| `TurnEnd` | `turn_end` | `usage` if present (for context tracking) |

**Note:** Exact ACP event field names are based on documented ACP protocol. During implementation, inspect actual `kiro-cli acp` JSON-RPC output to confirm field names and adjust mappings. The normalization function should log unrecognized event types at debug level for discovery.

Follows the same pattern as `src/server/agents/claude/messages.ts`.

### Factory Hookup

Update `src/server/agents/factory.ts` to import `KiroSession` and instantiate it when `agentType === 'kiro'`, replacing the current "not yet implemented" error.

### Environment

The factory already receives `agentProfile` via `CreateSessionOpts`. `KiroSession` reads it and sets `HOME` in the spawned process env. No schema or lifecycle changes needed.

---

## Stage 3: Log Tailing & Replay

### Session File Location

Kiro stores sessions at `{HOME}/.kiro/sessions/cli/{sessionId}/`. Each session directory contains metadata JSON and an event log JSONL file.

### Replay (History Loading)

When opening a card with an existing Kiro session, read the session's JSONL log file, normalize each event through `normalizeKiroMessage()`, and return them as history. Same pattern as Claude's `SessionTailer.readHistory()`.

Implemented in `src/server/agents/kiro/tailer.ts` as `KiroSessionTailer` (or by extending the existing `SessionTailer` with agent-aware path resolution).

### Live Tailing

During an active session, use the JSONL file tail as the **sole event source** (not stdio). The stdio stream handles only the JSON-RPC request/response transport for `initialize`, `session/new`, `session/prompt`, and `session/cancel`. All streaming content (agent messages, tool calls, etc.) is read from the JSONL file via tailing. This avoids dual-stream deduplication problems. If the JSONL file approach proves unreliable during implementation, fall back to stdio-only with no file tailing — never both simultaneously without dedup.

**File availability:** The tailer must handle the case where the JSONL file doesn't exist yet when tailing starts (Kiro may create it lazily after the first turn). Poll for file creation with a short interval (500ms) before beginning the tail watch, with a timeout matching `waitForReady()` (30s).

### Path Resolution

The tailer resolves session files at `{agentProfile}/.kiro/sessions/cli/{sessionId}/`. The `agentProfile` is available from the project linked to the card. The `sessionId` is captured during session initialization.

### Abstraction

Create `KiroSessionTailer` as a subclass of `SessionTailer` with an overridden path resolver. The base `SessionTailer` takes a file path; the Kiro subclass resolves `{agentProfile}/.kiro/sessions/cli/{sessionId}/events.jsonl` (exact filename TBD during implementation). Message normalization uses `normalizeKiroMessage()` instead of the Claude normalizer. The base class handles file watching and line buffering; the subclass handles path resolution and message parsing.

---

## Files Changed

### Stage 1
- Directory browser component (enhance with typeahead, paste, new folder)
- Server endpoint for creating directories
- `app/components/ProjectForm.tsx` (add agent type dropdown, conditional Kiro HOME picker)

### Stage 2
- `src/server/agents/kiro/session.ts` (new — KiroSession class)
- `src/server/agents/kiro/messages.ts` (new — normalizeKiroMessage)
- `src/server/agents/factory.ts` (wire up KiroSession)

### Stage 3
- `src/server/agents/kiro/tailer.ts` (new — Kiro session file reading/tailing)
- Potentially refactor `SessionTailer` for agent-aware path resolution

## Notes

- `KiroSession` leaves `model` and `thinkingLevel` fields unset — Kiro doesn't expose these via ACP currently.
- `kiro-cli` is expected to be on PATH. No minimum version check is enforced; if ACP protocol changes, the normalization layer will need updating.

## Out of Scope

- Docker sandbox fallback
- Profile management beyond the project form field
- Kiro model/thinking level configuration (defer until ACP supports it)
