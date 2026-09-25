# Meridian Session Backend Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace orc's direct Agent SDK usage with HTTP requests to meridian, gaining restart survival, streaming, and provider routing via a single endpoint.

**Architecture:** Orc becomes a thin UI client that sends standard Anthropic API requests to meridian (`POST /v1/messages` with `stream:true`). Meridian owns session lifecycle — it spawns Claude Code CLI subprocesses, manages conversation state, handles tool execution, and streams SSE events back. Provider routing uses the `x-meridian-profile` header: default profile for Anthropic (Claude Max OAuth), `kiro` profile for Kiro (routes to kiro-pool-proxy). Orc consumes the SSE stream and pipes events through socket.io to the browser for real-time token rendering.

**Tech Stack:** meridian v1.34.1, HTTP SSE streaming, socket.io, MobX

**Key design decisions:**

- Meridian runs as a separate systemd service (already exists on port 3456)
- Orc sends full conversation history per request (standard Anthropic API pattern); meridian deduplicates via its lineage/session tracking and resumes existing SDK sessions
- Working directory is passed in the system prompt `<env>` block; meridian's `extractClientCwd()` parses it
- Session ID tracked via `x-opencode-session` header (reuses meridian's existing session system)
- Non-passthrough mode: meridian executes all tools (Read, Write, Bash) internally via the SDK
- The SSE stream includes all events (text deltas, tool_use blocks, tool results) — orc renders them all

---

## File Structure

### New files

- `src/server/sessions/meridian-client.ts` — HTTP client that sends requests to meridian and returns a parsed SSE event stream
- `src/server/sessions/sse-parser.ts` — Parses `text/event-stream` response into typed event objects
- `src/server/sessions/event-translator.ts` — Converts Anthropic SSE events to the existing socket.io message format (so frontend changes are minimal)
- `src/server/sessions/conversation-store.ts` — In-memory conversation history per card (messages sent/received, for building follow-up requests)

### Modified files

- `src/server/sessions/manager.ts` — Replace SDK `query()` with meridian HTTP client; remove prompt channel
- `src/server/sessions/consumer.ts` — Replace SDK async generator loop with SSE stream consumption
- `src/server/sessions/types.ts` — Update `ActiveSession` type (remove `query`, `pushMessage`, `closeInput`; add `conversationMessages`, `abortController`)
- `src/server/init-state.ts` — Remove SessionManager (meridian owns sessions now); keep socket.io server
- `src/server/init.ts` — Remove anthropic proxy startup
- `src/server/ws/handlers/agents.ts` — Adapt to new session manager interface
- `src/shared/ws-protocol.ts` — No changes (existing event types are sufficient)
- `app/lib/message-accumulator.ts` — Add handling for raw `content_block_delta` events to enable token-by-token rendering
- `app/stores/session-store.ts` — Add streaming text state for in-progress content blocks
- `package.json` — Remove `@anthropic-ai/claude-agent-sdk` dependency, remove postinstall script

### Deleted files

- `src/server/anthropic-proxy.ts` — Meridian replaces this
- `src/server/sessions/prompt-channel.ts` — No longer needed (follow-ups are new HTTP requests)
- `scripts/patch-sdk-cache-control.sh` — No longer needed

### Config files (outside repo)

- `~/.config/meridian/profiles.json` — Kiro profile configuration

---

## Phase 1: Meridian Setup

### Task 1: Update and configure meridian

**Files:**

- Create: `~/.config/meridian/profiles.json`
- Modify: meridian systemd service (if version update needed)

- [ ] **Step 1: Update meridian to v1.34.1**

```bash
npm install -g @rynfar/meridian@1.34.1
```

- [ ] **Step 2: Create profiles.json with kiro profile**

```bash
mkdir -p ~/.config/meridian
cat > ~/.config/meridian/profiles.json << 'EOF'
[
  {
    "id": "kiro",
    "type": "api",
    "apiKey": "dummy",
    "baseUrl": "http://127.0.0.1:3457"
  }
]
EOF
```

- [ ] **Step 3: Restart meridian and verify profiles**

```bash
systemctl --user restart claude-max-proxy
curl -s http://127.0.0.1:3456/profiles | jq .
```

Expected: JSON listing default and kiro profiles.

- [ ] **Step 4: Verify kiro profile routing**

```bash
curl -s http://127.0.0.1:3456/health -H "x-meridian-profile: kiro"
```

Expected: Health check returns (may show auth error for kiro — that's fine, it means routing works).

- [ ] **Step 5: Verify default profile (anthropic) works**

```bash
curl -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":50,"stream":false,"messages":[{"role":"user","content":"say hi"}]}'
```

Expected: JSON response with assistant message.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-04-09-meridian-session-backend.md
git commit -m "docs: add meridian session backend migration plan"
```

---

## Phase 2: SSE Parser and Meridian Client

### Task 2: SSE stream parser

**Files:**

- Create: `src/server/sessions/sse-parser.ts`
- Test: Manual verification via curl (unit tests are brittle for stream parsing; integration test in Task 5)

- [ ] **Step 1: Create SSE parser module**

This parses a `text/event-stream` HTTP response body into typed event objects. It handles multi-line `data:` fields and the `event:` field.

```typescript
// src/server/sessions/sse-parser.ts

export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Parse an SSE byte stream into event objects.
 * Yields one SSEEvent per double-newline-delimited block.
 */
export async function* parseSSEStream(body: AsyncIterable<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = 'message';
      const dataLines: string[] = [];

      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) {
          event = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5));
        }
      }

      if (dataLines.length > 0) {
        yield { event, data: dataLines.join('\n') };
      }
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /home/ryan/Code/orchestrel && npx tsc --noEmit src/server/sessions/sse-parser.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/sse-parser.ts
git commit -m "feat: add SSE stream parser for meridian responses"
```

### Task 3: Meridian HTTP client

**Files:**

- Create: `src/server/sessions/meridian-client.ts`

- [ ] **Step 1: Create the meridian client module**

This sends Anthropic-format requests to meridian and returns a parsed SSE event stream. It handles provider routing via the `x-meridian-profile` header and session tracking via `x-opencode-session`.

```typescript
// src/server/sessions/meridian-client.ts

import { parseSSEStream, type SSEEvent } from './sse-parser';

const MERIDIAN_URL = process.env.MERIDIAN_URL ?? 'http://127.0.0.1:3456';

export interface MeridianRequestOpts {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  sessionId: string;
  profile?: string; // meridian profile name (e.g. 'kiro')
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface MeridianSession {
  events: AsyncGenerator<SSEEvent>;
  response: Response;
  abort: () => void;
}

/**
 * Send a streaming request to meridian and return the SSE event stream.
 */
export async function sendToMeridian(opts: MeridianRequestOpts): Promise<MeridianSession> {
  const controller = new AbortController();
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => controller.abort());
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': 'orchestrel',
    'x-opencode-session': opts.sessionId,
  };
  if (opts.profile) {
    headers['x-meridian-profile'] = opts.profile;
  }

  const body = JSON.stringify({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16384,
    stream: true,
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
  });

  const response = await fetch(`${MERIDIAN_URL}/v1/messages`, {
    method: 'POST',
    headers,
    body,
    signal: controller.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Meridian error ${response.status}: ${text}`);
  }

  if (!response.body) {
    throw new Error('Meridian returned no body');
  }

  return {
    events: parseSSEStream(response.body as AsyncIterable<Uint8Array>),
    response,
    abort: () => controller.abort(),
  };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit src/server/sessions/meridian-client.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/meridian-client.ts
git commit -m "feat: add meridian HTTP client with SSE streaming"
```

### Task 4: Conversation store

**Files:**

- Create: `src/server/sessions/conversation-store.ts`

- [ ] **Step 1: Create conversation store**

Tracks messages per card so follow-up requests include full history. Messages are stored in memory (not DB) since meridian is the source of truth for session state.

```typescript
// src/server/sessions/conversation-store.ts

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: unknown; // string or content block array
}

const conversations = new Map<number, ConversationMessage[]>();

export function getMessages(cardId: number): ConversationMessage[] {
  return conversations.get(cardId) ?? [];
}

export function addUserMessage(cardId: number, content: string): void {
  const msgs = conversations.get(cardId) ?? [];
  msgs.push({ role: 'user', content });
  conversations.set(cardId, msgs);
}

export function addAssistantMessage(cardId: number, content: unknown): void {
  const msgs = conversations.get(cardId) ?? [];
  msgs.push({ role: 'assistant', content });
  conversations.set(cardId, msgs);
}

export function clearConversation(cardId: number): void {
  conversations.delete(cardId);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/sessions/conversation-store.ts
git commit -m "feat: add in-memory conversation store for meridian requests"
```

---

## Phase 3: Event Translation

### Task 5: Event translator

**Files:**

- Create: `src/server/sessions/event-translator.ts`

- [ ] **Step 1: Create event translator**

Converts Anthropic SSE events into the message format the frontend already understands (`session:message` events). The goal is minimal frontend changes — the translator outputs objects that match the existing `SdkMessage` types.

```typescript
// src/server/sessions/event-translator.ts

import type { SSEEvent } from './sse-parser';

export interface TranslatedMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Translate a single Anthropic SSE event into the format the frontend expects.
 * Returns null for events that should be suppressed (e.g. ping).
 */
export function translateEvent(sse: SSEEvent): TranslatedMessage | null {
  if (sse.event === 'ping') return null;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(sse.data);
  } catch {
    return null;
  }

  switch (sse.event) {
    case 'message_start':
      return {
        type: 'system',
        subtype: 'init',
        session_id: (data.message as Record<string, unknown>)?.id ?? null,
        model: (data.message as Record<string, unknown>)?.model,
      };

    case 'content_block_start':
    case 'content_block_delta':
    case 'content_block_stop':
    case 'message_delta':
    case 'message_stop':
      return {
        type: 'stream_event',
        event: data,
      };

    case 'error':
      return {
        type: 'error',
        message: JSON.stringify(data),
        timestamp: Date.now(),
      };

    default:
      // Forward unknown events as stream_events for forward compatibility
      return {
        type: 'stream_event',
        event: data,
      };
  }
}

/**
 * Build a result message from the accumulated stream data.
 */
export function buildResultMessage(cost: number, usage: Record<string, unknown> | null): TranslatedMessage {
  return {
    type: 'result',
    subtype: 'success',
    total_cost_usd: cost,
    usage,
    duration_ms: 0,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/sessions/event-translator.ts
git commit -m "feat: add Anthropic SSE to socket.io event translator"
```

---

## Phase 4: Session Manager Refactor

### Task 6: Update session types

**Files:**

- Modify: `src/server/sessions/types.ts`

- [ ] **Step 1: Read current types**

Read `src/server/sessions/types.ts` to see current `ActiveSession` interface.

- [ ] **Step 2: Update ActiveSession to remove SDK types, add meridian fields**

Replace SDK-specific fields (`query`, `pushMessage`, `closeInput`) with meridian-oriented fields:

```typescript
// src/server/sessions/types.ts

export type SessionStatus = 'starting' | 'running' | 'completed' | 'errored' | 'stopped' | 'retry';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ActiveSession {
  cardId: number;
  sessionId: string;
  meridianSessionId: string; // x-opencode-session value
  provider: string;
  model: string;
  status: SessionStatus;
  promptsSent: number;
  turnsCompleted: number;
  turnCost: number;
  turnUsage: Usage | null;
  cwd: string;
  abortController: AbortController;
  stopTimeout: ReturnType<typeof setTimeout> | null;
}

export interface SessionStartOpts {
  provider: string;
  model: string;
  resume?: string;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/types.ts
git commit -m "refactor: update ActiveSession type for meridian backend"
```

### Task 7: Rewrite session consumer

**Files:**

- Modify: `src/server/sessions/consumer.ts`

- [ ] **Step 1: Read current consumer.ts**

Read the file to understand the current structure.

- [ ] **Step 2: Rewrite consumer to process SSE events from meridian**

Replace the SDK async generator loop with SSE event consumption. The consumer sends the request to meridian, iterates over SSE events, translates them, and publishes to the message bus.

```typescript
// src/server/sessions/consumer.ts

import type { ActiveSession } from './types';
import { messageBus } from '../bus';
import { sendToMeridian } from './meridian-client';
import { translateEvent, buildResultMessage } from './event-translator';
import { getMessages, addAssistantMessage } from './conversation-store';

function statusPayload(session: ActiveSession, active: boolean) {
  return {
    cardId: session.cardId,
    active,
    status: session.status,
    sessionId: session.sessionId,
    promptsSent: session.promptsSent,
    turnsCompleted: session.turnsCompleted,
    contextTokens: 0,
    contextWindow: 200_000,
  };
}

/**
 * Send a request to meridian and consume the SSE stream.
 * Publishes translated events to the message bus.
 */
export async function consumeSession(
  session: ActiveSession,
  systemPrompt: string,
  onExit: (session: ActiveSession) => void,
): Promise<void> {
  const { cardId } = session;
  const log = (msg: string) => console.log(`[session:${session.sessionId ?? cardId}] ${msg}`);
  const profile = session.provider === 'anthropic' ? undefined : session.provider;

  try {
    const meridian = await sendToMeridian({
      model: session.model,
      messages: getMessages(cardId),
      system: systemPrompt,
      sessionId: session.meridianSessionId,
      profile,
      signal: session.abortController.signal,
    });

    session.status = 'running';
    messageBus.publish(`card:${cardId}:status`, statusPayload(session, true));

    const contentBlocks: unknown[] = [];
    let usage: Record<string, unknown> | null = null;

    for await (const sse of meridian.events) {
      const msg = translateEvent(sse);
      if (!msg) continue;

      // Track session ID from message_start
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        if (!session.sessionId) {
          session.sessionId = msg.session_id as string;
          log(`init sessionId=${session.sessionId}`);
        }
      }

      // Track content blocks for conversation store
      if (msg.type === 'stream_event') {
        const evt = msg.event as Record<string, unknown>;
        if (evt.type === 'content_block_start') {
          contentBlocks.push(evt.content_block);
        }
        if (evt.type === 'content_block_delta') {
          // Update last content block with delta
          const idx = evt.index as number;
          const delta = evt.delta as Record<string, unknown>;
          const block = contentBlocks[idx] as Record<string, unknown> | undefined;
          if (block?.type === 'text' && delta.type === 'text_delta') {
            block.text = ((block.text as string) ?? '') + (delta.text as string);
          }
        }
        if (evt.type === 'message_delta') {
          usage = (evt.usage as Record<string, unknown>) ?? null;
        }
      }

      // Forward to UI
      messageBus.publish(`card:${cardId}:sdk`, msg);
    }

    // Store assistant response in conversation
    if (contentBlocks.length > 0) {
      addAssistantMessage(cardId, contentBlocks);
    }

    session.turnsCompleted++;
    session.turnCost = 0; // meridian doesn't expose cost in SSE yet
    log(`turn complete turns=${session.turnsCompleted}`);

    // Publish result
    messageBus.publish(`card:${cardId}:sdk`, buildResultMessage(session.turnCost, usage));

    session.status = 'completed';
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes('aborted') || errMsg.includes('AbortError')) {
      log(`consumer stopped cleanly: ${errMsg}`);
      if (session.status !== 'completed') session.status = 'stopped';
    } else {
      log(`consumer error: ${err}`);
      session.status = 'errored';
      messageBus.publish(`card:${cardId}:sdk`, {
        type: 'error',
        message: errMsg,
        timestamp: Date.now(),
      });
    }
  } finally {
    if (session.status === 'running') session.status = 'completed';
    log(`consumer exited (status=${session.status})`);
    messageBus.publish(`card:${cardId}:exit`, {
      sessionId: session.sessionId,
      status: session.status,
    });
    onExit(session);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/server/sessions/consumer.ts
git commit -m "refactor: rewrite consumer for meridian SSE stream"
```

### Task 8: Rewrite session manager

**Files:**

- Modify: `src/server/sessions/manager.ts`

- [ ] **Step 1: Read current manager.ts**

Read to understand the current interface that ws handlers depend on.

- [ ] **Step 2: Rewrite manager to use meridian client**

Replace SDK `query()` with HTTP requests to meridian. Keep the same public interface (`start`, `sendFollowUp`, `stop`, `setModel`, `get`, `has`, `isActive`) so ws handler changes are minimal.

```typescript
// src/server/sessions/manager.ts

import { resolve } from 'path';
import type { ActiveSession, SessionStartOpts } from './types';
import type { FileRef } from '../../shared/ws-protocol';
import { consumeSession } from './consumer';
import { ensureWorktree } from './worktree';
import { Card } from '../models/Card';
import { AppDataSource } from '../models/index';
import { addUserMessage, getMessages } from './conversation-store';

/** Prepend file-path instructions to a prompt when files are attached. */
export function buildPromptWithFiles(message: string, files?: FileRef[]): string {
  if (!files?.length) return message;
  for (const f of files) {
    if (!resolve(f.path).startsWith('/tmp/orchestrel-uploads/')) {
      throw new Error(`Invalid file path: ${f.path}`);
    }
  }
  const fileList = files.map((f) => `- ${f.path} (${f.name}, ${f.mimeType})`).join('\n');
  return `I've attached the following files for you to review. Use the Read tool to read them:\n${fileList}\n\n${message}`;
}

/** Build system prompt with working directory for meridian's extractClientCwd. */
function buildSystemPrompt(cwd: string): string {
  return `<env>\nWorking directory: ${cwd}\n</env>`;
}

export class SessionManager {
  private sessions = new Map<number, ActiveSession>();

  async start(cardId: number, prompt: string, opts: SessionStartOpts): Promise<ActiveSession> {
    // If session already active, send as follow-up instead
    const existing = this.sessions.get(cardId);
    if (existing && (existing.status === 'running' || existing.status === 'starting' || existing.status === 'retry')) {
      this.sendFollowUp(cardId, prompt);
      return existing;
    }

    // Load card and ensure worktree
    const card = await AppDataSource.getRepository(Card).findOneByOrFail({ id: cardId });
    const cwd = await ensureWorktree(card);

    // Add user message to conversation store
    addUserMessage(cardId, prompt);

    const meridianSessionId = opts.resume ?? `card-${cardId}-${Date.now()}`;

    const session: ActiveSession = {
      cardId,
      sessionId: null,
      meridianSessionId,
      provider: opts.provider,
      model: opts.model,
      status: 'starting',
      promptsSent: 1,
      turnsCompleted: 0,
      turnCost: 0,
      turnUsage: null,
      cwd,
      abortController: new AbortController(),
      stopTimeout: null,
    };

    this.sessions.set(cardId, session);

    // Fire-and-forget consumer
    consumeSession(session, buildSystemPrompt(cwd), (s) => {
      if (s.stopTimeout) clearTimeout(s.stopTimeout);
      this.sessions.delete(s.cardId);
    });

    return session;
  }

  sendFollowUp(cardId: number, message: string): void {
    const session = this.sessions.get(cardId);
    if (!session) throw new Error(`No active session for card ${cardId}`);

    // Add to conversation store
    addUserMessage(cardId, message);
    session.promptsSent++;
    session.status = 'starting';

    // Start a new consumer for the follow-up (new HTTP request to meridian)
    consumeSession(session, buildSystemPrompt(session.cwd), (s) => {
      if (s.stopTimeout) clearTimeout(s.stopTimeout);
      this.sessions.delete(s.cardId);
    });
  }

  stop(cardId: number): void {
    const session = this.sessions.get(cardId);
    if (!session) return;

    console.log(`[session:${session.sessionId ?? cardId}] stop requested`);
    session.status = 'stopped';
    session.abortController.abort();

    // Hard kill fallback
    session.stopTimeout = setTimeout(() => {
      if (!this.sessions.has(cardId)) return;
      console.log(`[session:${session.sessionId ?? cardId}] abort timeout, forcing cleanup`);
      this.sessions.delete(cardId);
    }, 5_000);
  }

  setModel(cardId: number, provider: string, model: string): void {
    const session = this.sessions.get(cardId);
    if (!session) return;

    session.provider = provider;
    session.model = model;
    console.log(`[session:${session.sessionId ?? cardId}] model changed to ${provider}:${model}`);
  }

  get(cardId: number): ActiveSession | undefined {
    return this.sessions.get(cardId);
  }

  has(cardId: number): boolean {
    return this.sessions.has(cardId);
  }

  isActive(cardId: number): boolean {
    const s = this.sessions.get(cardId);
    if (!s) return false;
    return s.status === 'starting' || s.status === 'running' || s.status === 'retry';
  }
}
```

- [ ] **Step 3: Verify it compiles**

```bash
npx tsc --noEmit src/server/sessions/manager.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/server/sessions/manager.ts
git commit -m "refactor: rewrite session manager to use meridian HTTP client"
```

### Task 9: Update ws handlers for new session types

**Files:**

- Modify: `src/server/ws/handlers/agents.ts`

- [ ] **Step 1: Read current agents.ts**

Read to identify what references SDK-specific types.

- [ ] **Step 2: Update handlers**

The main change: remove the `import { startAnthropicProxy }` and any SDK-specific code. The handler interface (agent:send, agent:stop) should remain the same since the session manager's public API hasn't changed.

Key changes:

- Remove any references to `startAnthropicProxy`
- Remove any references to SDK query types
- The `agent:send` handler calls `sessionManager.start()` or `sendFollowUp()` — this interface is unchanged
- The `agent:stop` handler calls `sessionManager.stop()` — this interface is unchanged

- [ ] **Step 3: Verify it compiles**

```bash
npx tsc --noEmit src/server/ws/handlers/agents.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/server/ws/handlers/agents.ts
git commit -m "refactor: update ws handlers for meridian session manager"
```

---

## Phase 5: Frontend Streaming

### Task 10: Add real-time text delta rendering

**Files:**

- Modify: `app/lib/message-accumulator.ts`
- Modify: `app/stores/session-store.ts`

- [ ] **Step 1: Read current message-accumulator.ts**

Understand how `stream_event` messages are currently handled.

- [ ] **Step 2: Update MessageAccumulator to handle content_block_delta for streaming text**

The accumulator should:

1. On `content_block_start` with `type: "text"`: create a new in-progress text block
2. On `content_block_delta` with `type: "text_delta"`: append delta text to the in-progress block
3. On `content_block_stop`: finalize the block

This enables token-by-token rendering. The key change is that text blocks are rendered incrementally instead of waiting for the complete `assistant` message.

- [ ] **Step 3: Update SessionStore to expose streaming state**

Add an observable `streamingText` field that updates on each `content_block_delta`. The conversation view component can render this for the in-progress message.

- [ ] **Step 4: Verify frontend renders streaming text**

Start orc, open a card, send a prompt. Text should appear token-by-token in the chat view instead of in complete blocks.

- [ ] **Step 5: Commit**

```bash
git add app/lib/message-accumulator.ts app/stores/session-store.ts
git commit -m "feat: add real-time token streaming in chat view"
```

---

## Phase 6: Cleanup

### Task 11: Remove SDK dependency and old proxy

**Files:**

- Delete: `src/server/anthropic-proxy.ts`
- Delete: `src/server/sessions/prompt-channel.ts`
- Delete: `scripts/patch-sdk-cache-control.sh`
- Modify: `package.json` — remove `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/claude-code`, remove postinstall script
- Modify: `src/server/init-state.ts` — remove SDK-specific initialization
- Modify: `src/server/init.ts` — remove anthropic proxy startup

- [ ] **Step 1: Remove anthropic-proxy.ts**

```bash
rm src/server/anthropic-proxy.ts
```

- [ ] **Step 2: Remove prompt-channel.ts**

```bash
rm src/server/sessions/prompt-channel.ts
```

- [ ] **Step 3: Remove postinstall patch script**

```bash
rm scripts/patch-sdk-cache-control.sh
```

- [ ] **Step 4: Update package.json**

Remove from dependencies:

- `@anthropic-ai/claude-agent-sdk`
- `@anthropic-ai/claude-code`

Remove from scripts:

- `"postinstall": "bash scripts/patch-sdk-cache-control.sh"`

- [ ] **Step 5: Update init-state.ts**

Remove SessionManager from init-state since it no longer needs to survive Vite restarts (meridian owns sessions). The SessionManager can be a regular import in the handlers now.

- [ ] **Step 6: Update init.ts**

Remove the anthropic proxy startup code.

- [ ] **Step 7: Run pnpm install to clean up node_modules**

```bash
pnpm install
```

- [ ] **Step 8: Verify full build**

```bash
pnpm build
```

Expected: Build succeeds with no SDK references.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: remove SDK dependency, anthropic proxy, and postinstall patch"
```

### Task 12: Update CLAUDE.md

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Update architecture section**

Add meridian as the session backend. Update the dev server section to note meridian dependency. Remove references to the SDK subprocess model.

Key additions:

- Meridian runs on port 3456 as the session backend
- Provider routing via `x-meridian-profile` header
- Kiro profile configured in `~/.config/meridian/profiles.json`
- Sessions survive orc restarts (meridian owns them)
- `MERIDIAN_URL` env var overrides default `http://127.0.0.1:3456`

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for meridian session backend"
```

---

## Open Questions / Future Work

1. **Cost tracking**: Meridian doesn't expose per-request cost in its SSE stream. The `usage` field in `message_delta` has token counts but not dollar amounts. Orc currently tracks `turnCost` — this may need to be computed from token counts + model pricing.

2. **Session recovery on orc restart**: If orc restarts while an agent is mid-turn, the stream is lost from orc's perspective but the agent continues in meridian. On reconnect, orc should query meridian for session status and catch up on missed events. Meridian's telemetry endpoint (`GET /telemetry`) may help, but a proper "get session messages" API would be needed for full recovery. For MVP, the user can click "Continue" to resume.

3. **Conversation store persistence**: Currently in-memory only. If orc restarts, conversation history is lost and follow-ups won't include prior messages. Options: persist to DB, or load from meridian's session cache on reconnect. For MVP, the session ID ensures meridian resumes the right SDK session regardless.

4. **Model switching mid-session**: Currently `setModel()` just updates the session object. The next request to meridian will use the new model. But meridian's session tracking might create a new SDK session if the model changes. Need to verify behavior.

5. **Adapter selection**: Orc currently uses meridian's default opencode adapter (detected by user-agent). We may want a dedicated orchestrel adapter in meridian for better cwd extraction, session ID handling, and tool visibility. For MVP, the opencode adapter works — cwd is extracted from the `<env>` system prompt block.

6. **Tool visibility in stream**: Verify that meridian streams tool_use and tool_result events in non-passthrough mode. If not, orc loses visibility into what the agent is doing (file reads, edits, bash commands). This is critical for the UI.

7. **Empty text block bug**: Meridian uses the same Agent SDK internally, so the empty text block bug may still occur inside meridian's SDK subprocess. Options: (a) contribute a fix upstream to meridian, (b) apply the postinstall patch to meridian's copy of the SDK, (c) ignore — the bug causes retries inside meridian but doesn't surface to orc since orc never sees the raw Anthropic API request. Need to verify which case applies.

8. **Meridian version pinning**: Meridian releases frequently (multiple times per week). Pin to a known-good version in deployment docs to avoid surprises. Current target: v1.34.1.
