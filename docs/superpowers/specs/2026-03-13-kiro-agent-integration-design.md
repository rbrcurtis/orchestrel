# Kiro Agent Integration

## Overview

Add Kiro as a second agent type in Dispatcher. Projects can select Claude Code (default) or Kiro, with Kiro requiring a HOME directory for auth isolation. The directory browser component gets enhanced with typeahead filtering, paste support, and folder creation. KiroSession implements the ACP (Agent Client Protocol) over stdio. Log tailing and session replay round out feature parity with Claude.

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

**New Folder button:** A button in the directory listing. Clicking shows an inline text input prompting for the folder name, with confirm/cancel. On confirm, creates the directory via a server call and refreshes the listing. The new folder is created inside whatever directory is currently being browsed.

### ProjectForm Agent Fields

Two new fields in ProjectForm, placed after the project path section:

1. **Agent Type** — Select dropdown: "Claude Code" (default), "Kiro". Stored as `agentType` on the project.

2. **Kiro HOME** — Directory picker (same enhanced component as project path). Only visible when agent type is "Kiro". Stored as `agentProfile` on the project. Label: "Kiro HOME" with hint text: "Auth & config directory for this Kiro instance".

**Validation:** When agent type is Kiro, `agentProfile` is required. When Claude Code, `agentProfile` is ignored and cleared.

**Existing support:** The DB schema (`agentType`, `agentProfile` columns), project store, WS protocol schemas, and `begin-session.ts` already read and pass these fields through. Only the form UI is new.

---

## Stage 2: KiroSession + Factory

### KiroSession Class

`KiroSession` extends `AgentSession` in `src/server/agents/kiro/session.ts`.

Spawns `kiro-cli acp` over stdio with `HOME` set to the `agentProfile` path and `cwd` set to the project path. Communicates via JSON-RPC 2.0 on stdin/stdout.

**Lifecycle:**

- `start()` — Spawn child process with `{ env: { ...process.env, HOME: agentProfile }, cwd }`. Send `initialize` JSON-RPC request. Then send `session/new` (or `session/load` if resuming via `resumeSessionId`). Mark ready once initialize response is received.
- `sendMessage(text)` — Send `session/prompt` JSON-RPC request with the prompt text.
- `kill()` — Send `session/cancel`, then kill the child process.
- `waitForReady()` — Wait for initialize handshake to complete (30s timeout, same pattern as ClaudeSession).

### Message Normalization

`src/server/agents/kiro/messages.ts` — `normalizeKiroMessage()` maps ACP notification events to `AgentMessage`:

| ACP Event | AgentMessage type |
|---|---|
| `AgentMessageChunk` | `text` |
| `ToolCall` | `tool_call` |
| `ToolCallUpdate` | `tool_progress` |
| `TurnEnd` | `turn_end` |

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

During an active session, tail the JSONL file for new events and emit them through the existing event pipeline. This supplements the stdio stream and ensures no events are missed if the stdio normalization misses edge cases.

### Path Resolution

The tailer resolves session files at `{agentProfile}/.kiro/sessions/cli/{sessionId}/`. The `agentProfile` is available from the project linked to the card. The `sessionId` is captured during session initialization.

### Abstraction

The existing `SessionTailer` class may need to become agent-aware (accepting a path resolver function) or be subclassed per agent type. The exact approach depends on how similar the file formats are — Claude uses a single JSONL file while Kiro may use a directory with multiple files.

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

## Out of Scope

- Docker sandbox fallback
- Profile management beyond the project form field
- Kiro model/thinking level configuration (defer until ACP supports it)
