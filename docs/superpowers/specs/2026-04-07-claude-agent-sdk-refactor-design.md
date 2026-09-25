# Claude Agent SDK Refactor

Replace OpenCode daemon + `@opencode-ai/sdk` with `@anthropic-ai/claude-agent-sdk` and `claude-code-router` (CCR). Complete rewrite of the session layer with native SDK types throughout.

## Architecture

```
Orchestrel Server
  ├── SessionManager (holds Query objects + metadata)
  ├── Consumer loops (iterate SDK async generators, publish to bus)
  ├── Event Bus (SDK messages flow through)
  └── WS (forwards SDK messages to UI)
        │
        ▼
  Agent SDK V1 query() → spawns Claude Code subprocess
        │
        ▼
  CCR (port 3456) — custom router parses model prefix, routes to provider
        │
        ├── Anthropic (direct)
        ├── Trackable (Bedrock, multi-key)
        ├── Okkanti (Bedrock)
        └── Future providers (OpenAI, Kai, etc.)
```

Key changes from current architecture:

- No external daemon. OpenCode ran on port 4097. Agent SDK spawns Claude Code as a subprocess per session.
- No SSE. The `Query` async generator replaces SSE streaming.
- No `AgentSession` abstract class. Sessions ARE `Query` objects.
- No message translation layer. `SDKMessage` types flow through the bus to WS clients.
- CCR replaces OpenCode's provider plugins for routing, auth, and key rotation.

What stays: event bus pub/sub, WS connection/subscription management, card model, worktree management, queue-gate serialization, Vite dev server survival via init-state.ts.

## Session Layer

### SessionManager

```typescript
interface ActiveSession {
  cardId: string;
  query: Query;
  sessionId: string;
  provider: string; // "anthropic", "trackable", "okkanti"
  model: string; // "claude-opus-4-6"
  status: 'starting' | 'running' | 'completed' | 'stopped' | 'errored' | 'retry';
  promptsSent: number;
  turnsCompleted: number;
  turnCost: number;
  turnUsage: Usage | null;
}

class SessionManager {
  private sessions = new Map<string, ActiveSession>();

  async start(cardId, prompt, opts: { provider; model; cwd; resume?; files? }): Promise<ActiveSession>;
  sendFollowUp(cardId, message, files?): void;
  stop(cardId): void;
  setModel(cardId, provider, model): void;
  get(cardId): ActiveSession | undefined;
  has(cardId): boolean;
  isActive(cardId): boolean;
}
```

### Session Lifecycle

**Start:** Call `query()` from Agent SDK V1 with model encoded as `${provider}:${model}`, `permissionMode: 'bypassPermissions'`, `systemPrompt: { type: 'preset', preset: 'claude_code' }`, `settingSources: ['user', 'project']`. Fire-and-forget consumer loop iterates the async generator.

**Follow-up:** Call `query.streamInput()` with a new user message. The consumer loop (already running) picks up new output.

**Stop:** Call `query.interrupt()`. Consumer loop receives interruption and cleans up.

**Resume:** Same as start but with `resume: storedSessionId`. Agent SDK picks up prior session transcript from disk.

**Model/provider switch:** Call `query.setModel('${newProvider}:${newModel}')`. Takes effect on next turn.

**Compaction:** Send a user message requesting compaction via `streamInput()`. Auto-compaction still happens natively (SDK emits `compact_boundary` system messages).

### Consumer Loop

```typescript
async function consumeSession(session: ActiveSession): Promise<void> {
  try {
    for await (const msg of session.query) {
      // Update ActiveSession state based on message type
      // Publish forwarded messages to bus (card:${cardId}:sdk topic)
      // Filter out internal bookkeeping (hooks, auth, files_persisted)
    }
  } finally {
    sessions.delete(session.cardId);
    bus.publish(`card:${session.cardId}:exit`, { sessionId: session.sessionId });
  }
}
```

### What This Replaces

- `AgentSession` abstract class (deleted)
- `OpenCodeSession` 800-line class (deleted — replaced by ~150 lines)
- `SessionService` facade (deleted — merged into SessionManager)
- `agents/factory.ts` (deleted)
- `opencode/server.ts` (deleted — no external daemon)
- SSE subscription + event parsing (replaced by `for await`)
- Permission auto-approval handler (replaced by `permissionMode: 'bypassPermissions'`)
- Prompt timeout / idle fallback timers (SDK handles internally)
- Child session tracking (SDK emits `task_*` messages natively)
- `normalizeOpenCodeEvent()` (deleted — SDK messages used directly)

## Event & Message Flow

### Streaming

Use `includePartialMessages: true` on `query()`. This yields `SDKPartialAssistantMessage` (type `"stream_event"`) containing Anthropic streaming deltas for real-time text/thinking rendering.

### Messages Forwarded to UI

| SDK Message Type                                       | UI Purpose                                   |
| ------------------------------------------------------ | -------------------------------------------- |
| `system` (init)                                        | Session started, capture sessionId           |
| `system` (compact_boundary)                            | Show compaction marker                       |
| `stream_event`                                         | Real-time text/thinking/tool-input streaming |
| `assistant`                                            | Complete message (history reconstruction)    |
| `result`                                               | Turn complete — cost, usage, duration        |
| `tool_progress`                                        | Tool execution status                        |
| `tool_use_summary`                                     | Tool result summary                          |
| `task_started` / `task_progress` / `task_notification` | Subagent activity                            |
| `rate_limit`                                           | Retry state                                  |
| `status`                                               | General status                               |

Filtered out (not forwarded): `hook_*`, `auth_status`, `files_persisted`, `prompt_suggestion`.

### Bus Topics

```
card:${cardId}:sdk      — SDK messages forwarded to UI
card:${cardId}:status   — session status changes
card:${cardId}:exit     — session ended
board:changed           — card column/queue changes (unchanged)
```

### WS Wire Format

```typescript
{ type: 'session:message', cardId: string, message: SDKMessage }
{ type: 'session:status',  cardId: string, status: SessionStatus }
{ type: 'session:exit',    cardId: string, sessionId: string }
{ type: 'card:updated',    card: Card }           // unchanged
{ type: 'board:changed',   card: Card, ... }      // unchanged
{ type: 'mutation:ok',     id: string }            // unchanged
{ type: 'mutation:error',  id: string, error }     // unchanged
```

## Provider Routing & CCR Integration

### Model Name Encoding

Every `query()` call encodes provider as model prefix: `{provider}:{model}` (e.g., `trackable:claude-opus-4-6`). Agent SDK passes this verbatim in API requests to `ANTHROPIC_BASE_URL` (CCR).

### CCR Custom Router

`~/.claude-code-router/custom-router.js`:

```javascript
// Maps Orchestrel provider prefixes to CCR provider names
// For multi-key providers, the first entry is the primary;
// CCR's fallback config handles failover to subsequent entries.
const primaryProvider = {
  trackable: 'trackable-1',
  okkanti: 'okkanti',
  anthropic: 'anthropic',
};

module.exports = async function router(req, config) {
  const model = req.body.model;
  const [provider, actualModel] = model.split(':');
  if (!actualModel) return null;

  req.body.model = actualModel;

  const ccrProvider = primaryProvider[provider] ?? provider;
  return `${ccrProvider},${actualModel}`;
};
```

### 429 Failover

The custom router runs _before_ the request and selects the primary provider. CCR's built-in `fallback` config handles error-based failover (including 429). For Trackable with 2 AWS accounts:

```json
{
  "fallback": {
    "default": ["trackable-2,claude-opus-4-6", "trackable-2,claude-sonnet-4-6"]
  }
}
```

When `trackable-1` returns a 429, CCR automatically retries with `trackable-2`. Failover, not round-robin.

### Orchestrel Provider Config

Simplified `providers.json`:

```json
{
  "providers": {
    "anthropic": {
      "label": "Anthropic",
      "models": {
        "sonnet": { "label": "Sonnet 4.6", "modelId": "claude-sonnet-4-6" },
        "opus": { "label": "Opus 4.6", "modelId": "claude-opus-4-6" }
      }
    },
    "trackable": {
      "label": "Trackable",
      "models": {
        "sonnet": { "label": "Sonnet 4.6", "modelId": "claude-sonnet-4-6" },
        "opus": { "label": "Opus 4.6", "modelId": "claude-opus-4-6" }
      }
    },
    "okkanti": {
      "label": "Okkanti",
      "models": {
        "sonnet": { "label": "Sonnet 4.6", "modelId": "claude-sonnet-4-6" }
      }
    }
  }
}
```

Provider key IS the CCR routing prefix. No more `ocProviderID` mapping.

### Runtime Provider Switching

UI adds provider dropdown alongside model/thinking controls. Changing provider sends `session:set-model` over WS, server calls `query.setModel('${provider}:${model}')`. Takes effect on next turn. Provider persisted on card (`provider` column, default `"anthropic"`).

## UI Changes

### Message Rendering

Replace flat `AgentMessage` rendering with `MessageAccumulator` that builds renderable state from SDK stream events:

- `TextBlock` — streaming text (from `content_block_delta` with `text_delta`)
- `ThinkingBlock` — streaming thinking (from `content_block_delta` with `thinking_delta`)
- `ToolUseBlock` — tool name + input + result (from `content_block_start/delta/stop` + `tool_progress`)
- `SubagentActivity` — from `task_*` messages
- `RetryBanner` — from `rate_limit` messages
- `TurnEnd` — from `result` message (cost, usage)
- `CompactBoundary` — from `system` compact_boundary

### Provider Switcher

Provider dropdown in chat input area. Lists providers from `providers.json`. Change takes effect on next turn without session restart.

### Session History

Load via Agent SDK's `getSessionMessages(sessionId)`. Returns `SessionMessage[]`, forwarded to UI as `session:message` events.

## Infrastructure

### Vite Dev Server Survival

SessionManager lives in `init-state.ts` (dynamically imported). Query objects (Claude Code subprocesses) and their consumer loops survive Vite rebundles. Bus listeners and WS handlers re-wired on each `configureServer` call.

### Environment

Agent SDK sessions spawned with:

```typescript
env: {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',  // CCR
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
}
```

CCR's server auth (`APIKEY`) left unset for localhost.

### Auth / Key Management

Keys managed by editing `~/.claude-code-router/config.json` directly or via `ccr ui`. No custom CLI in initial scope.

### Dependencies

```
- @opencode-ai/sdk              (remove)
+ @anthropic-ai/claude-agent-sdk
+ @anthropic-ai/claude-code      (required — SDK spawns it)
```

CCR installed separately, not a project dependency.

## File Migration

### Deleted

- `src/server/agents/opencode/` (session.ts, messages.ts, models.ts)
- `src/server/agents/types.ts`
- `src/server/agents/factory.ts`
- `src/server/agents/manager.ts`
- `src/server/opencode/` (server.ts)
- `src/server/services/session.ts`
- OpenCode plugins (`~/.config/opencode/plugins/anthropic-oauth.js`, etc.)

### Created

- `src/server/sessions/manager.ts`
- `src/server/sessions/types.ts`
- `src/server/sessions/consumer.ts`
- `~/.claude-code-router/custom-router.js`
- `app/lib/message-accumulator.ts`
- Frontend types mirroring SDK message shapes

### Modified

- `src/server/init-state.ts` — add SessionManager, remove OpenCode refs
- `src/server/ws/handlers/agents.ts` — call new SessionManager
- `src/server/controllers/oc.ts` — wireSession replaced, autoStart/cleanup use new SessionManager
- `src/server/services/queue-gate.ts` — call `sessionManager.start()`
- `src/server/config/providers.ts` — simplified, no ocProviderID
- `src/server/models/Card.ts` — add `provider` column
- `providers.json` — simplified format
- `package.json` — swap SDK dependencies
- Chat UI components — render SDK messages via accumulator
- Model switcher — add provider dropdown

### Unchanged

- `src/server/bus.ts`
- `src/server/ws/server.ts` (minus OpenCode init)
- `src/server/ws/connections.ts`
- `src/server/ws/subscriptions.ts`
- `src/server/worktree.ts`
- `src/server/models/Project.ts`, `User.ts`
- `src/server/ws/auth.ts`

## Risk: Model Name Validation

The design assumes Claude Code passes the prefixed model string (`trackable:claude-opus-4-6`) through to the API request without validation. If Claude Code validates model names, the prefix approach won't work. This must be verified early. Fallback: encode provider in the system prompt instead and parse it in CCR's custom router.
