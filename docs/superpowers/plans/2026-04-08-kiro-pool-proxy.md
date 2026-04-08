# Kiro Pool Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform kiro-ccr-auth into kiro-pool-proxy — an HTTP proxy that accepts Anthropic Messages API requests, converts them to CodeWhisperer format, routes to the correct Kiro account pool, and streams back Anthropic-format SSE responses.

**Architecture:** The proxy exposes `POST /v1/messages` (Anthropic-compatible). It parses the pool name from the model prefix (`trackable:claude-sonnet-4-6` → pool `trackable`, model `claude-sonnet-4-6`), selects the best account from that pool (existing lowest-usage logic), converts the Anthropic request body to CodeWhisperer `generateAssistantResponse` format, sends it with the account's Bearer token, parses the AWS binary event stream response, and emits Anthropic SSE events back to the caller. The existing CLI (login/status/logout/refresh) remains unchanged.

**Tech Stack:** TypeScript, Node.js built-in `http` module (no framework needed — single endpoint), existing `better-sqlite3` for account DB, `node:crypto` for UUIDs.

---

## Background

### What is CodeWhisperer/Q Developer API?

Kiro accounts use the AWS Q Developer API (formerly CodeWhisperer) at `https://codewhisperer.{region}.amazonaws.com/generateAssistantResponse`. This API has a completely different request/response format from the Anthropic Messages API. The request uses `conversationState` with `userInputMessage`, `history[]`, `profileArn`, and `toolSpecification` instead of Anthropic's `messages[]`, `system`, and `tools[]`. The response is an AWS binary event stream (`application/vnd.amazon.eventstream`) instead of SSE text.

### Where is the prior art?

The format conversion logic is well-documented in two open-source projects:
- **kiro-gateway** (Python, AGPL-3.0, github.com/jwadow/kiro-gateway) — comprehensive Anthropic→CodeWhisperer converter with streaming, tool use, images. Reference files: `converters_core.py`, `converters_anthropic.py`, `parsers.py`, `streaming_anthropic.py`, `streaming_core.py`. A clone is at `/tmp/kiro-gateway/` for reference.
- **Zhang CCR fork** (`@jasonzhangf/claude-code-router-enhanced`, npm) — simpler JS implementation with `K2ccTransformer.buildCodeWhispererRequest()` and `parseSSEEvents()`. Extracted at `/tmp/ccr-inspect/package/dist/cli.js` lines 57020-57593.

### What already exists in kiro-ccr-auth?

The project at `~/Code/kiro-ccr-auth/` already has:
- **CLI:** `src/cli.ts` — login, status, logout, refresh commands via `arg` library
- **Account selection:** `src/lib/accounts.ts` — `selectAccount(pool)` returns best account, handles token refresh, health tracking
- **DB:** `src/lib/db.ts` — SQLite at `~/.config/kiro-auth/accounts.db`, `Account` interface, CRUD operations, health/usage tracking
- **Config:** `src/lib/config.ts` — loads `config.json` with pool definitions (`startUrl`, `profileArn`, `oidcRegion`, `serviceRegion`)
- **Token refresh:** `src/lib/refresh.ts` — IDC and desktop refresh methods
- **OIDC:** `src/lib/oidc.ts` — device code flow for login
- **Usage:** `src/lib/usage.ts` — fetches usage limits from Q Developer API
- **Dead code:** `src/transformer.ts` and `src/custom-router.ts` — CCR integration that doesn't work (CCR has no CodeWhisperer support). Will be deleted.

### How does Orchestrel use this?

Orchestrel's `SessionManager` (`src/server/sessions/manager.ts` in the orchestrel repo) spawns Claude Code subprocesses. For Kiro providers, it sets `ANTHROPIC_BASE_URL=http://127.0.0.1:3457` and encodes the model as `trackable:claude-sonnet-4-6`. The proxy must listen on that port and handle these requests.

---

## File Structure

All paths relative to `~/Code/kiro-ccr-auth/` (will be renamed to `~/Code/kiro-pool-proxy/`).

### New files

| File | Responsibility |
|---|---|
| `src/server.ts` | HTTP server on configurable port. Single `POST /v1/messages` route. Parses pool from model prefix, delegates to handler. |
| `src/proxy/handler.ts` | Request handler: selects account, calls converter, sends to CodeWhisperer, streams response back. Orchestrates the full request lifecycle. |
| `src/proxy/convert-request.ts` | Anthropic Messages request → CodeWhisperer `generateAssistantResponse` payload. Pure function, no I/O. |
| `src/proxy/convert-response.ts` | AWS binary event stream → Anthropic SSE events. Parses binary frames, extracts JSON events, emits formatted SSE strings. |
| `src/proxy/types.ts` | TypeScript interfaces for Anthropic request/response types and CodeWhisperer types. |
| `src/proxy/model-map.ts` | Maps Anthropic model names (e.g., `claude-sonnet-4-6`) to CodeWhisperer model IDs (e.g., `claude-sonnet-4.6`). |
| `tests/convert-request.test.ts` | Unit tests for request conversion. |
| `tests/convert-response.test.ts` | Unit tests for response stream parsing. |
| `tests/model-map.test.ts` | Unit tests for model name normalization. |

### Modified files

| File | Change |
|---|---|
| `package.json` | Rename to `kiro-pool-proxy`, add `"serve"` script, add `vitest` dev dependency |
| `src/cli.ts` | Add `serve` command that starts the HTTP server |
| `src/lib/config.ts` | Add `port` field to Config (default 3457) |
| `config.json` | Add `"port": 3457` |

### Deleted files

| File | Reason |
|---|---|
| `src/transformer.ts` | Dead code — CCR transformer approach doesn't work |
| `src/custom-router.ts` | Dead code — CCR custom router not needed |

---

## Task 1: Rename project and clean up dead code

**Files:**
- Modify: `~/Code/kiro-ccr-auth/package.json`
- Delete: `~/Code/kiro-ccr-auth/src/transformer.ts`
- Delete: `~/Code/kiro-ccr-auth/src/custom-router.ts`

- [ ] **Step 1: Rename the directory**

```bash
mv ~/Code/kiro-ccr-auth ~/Code/kiro-pool-proxy
```

- [ ] **Step 2: Update package.json**

In `~/Code/kiro-pool-proxy/package.json`, change the name and add vitest + serve script:

```json
{
  "name": "kiro-pool-proxy",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "kiro-auth": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "serve": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "arg": "^5.0.2",
    "better-sqlite3": "^12.6.0",
    "open": "^10.1.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 3: Delete dead code**

```bash
rm ~/Code/kiro-pool-proxy/src/transformer.ts ~/Code/kiro-pool-proxy/src/custom-router.ts
```

- [ ] **Step 4: Install vitest**

```bash
cd ~/Code/kiro-pool-proxy && pnpm install
```

- [ ] **Step 5: Update symlink**

```bash
rm ~/bin/kiro-auth 2>/dev/null; ln -s ~/Code/kiro-pool-proxy/dist/cli.js ~/bin/kiro-auth
```

- [ ] **Step 6: Build and verify CLI still works**

```bash
cd ~/Code/kiro-pool-proxy && pnpm build && node dist/cli.js status
```

Expected: Shows trackable and okkanti pools with account info (no errors about missing transformer.ts).

- [ ] **Step 7: Commit**

```bash
cd ~/Code/kiro-pool-proxy && git add -A && git commit -m "refactor: rename to kiro-pool-proxy, remove dead CCR code"
```

---

## Task 2: TypeScript types for Anthropic and CodeWhisperer formats

**Files:**
- Create: `~/Code/kiro-pool-proxy/src/proxy/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// Anthropic Messages API request types (subset used by Claude Code)

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  // image
  source?: { type: string; media_type: string; data: string };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: string };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  max_tokens: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  temperature?: number;
}

// CodeWhisperer generateAssistantResponse types

export interface CWToolSpecification {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export interface CWToolResult {
  content: { text: string }[];
  status: 'success' | 'error';
  toolUseId: string;
}

export interface CWUserInputMessage {
  content: string;
  modelId: string;
  origin: 'AI_EDITOR';
  userInputMessageContext?: {
    tools?: CWToolSpecification[];
    toolResults?: CWToolResult[];
  };
}

export interface CWHistoryEntry {
  userInputMessage?: CWUserInputMessage;
  assistantResponseMessage?: {
    content: string;
    toolUses?: {
      toolUseId: string;
      name: string;
      input: unknown;
    }[];
  };
}

export interface CWRequest {
  profileArn: string;
  conversationState: {
    chatTriggerType: 'MANUAL';
    conversationId: string;
    currentMessage: {
      userInputMessage: CWUserInputMessage;
    };
    history?: CWHistoryEntry[];
  };
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/Code/kiro-pool-proxy && git add src/proxy/types.ts && git commit -m "feat: add TypeScript types for Anthropic and CodeWhisperer formats"
```

---

## Task 3: Model name mapping

**Files:**
- Create: `~/Code/kiro-pool-proxy/src/proxy/model-map.ts`
- Create: `~/Code/kiro-pool-proxy/tests/model-map.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeModelName } from '../src/proxy/model-map.js';

describe('normalizeModelName', () => {
  it('converts dashes to dots for minor version', () => {
    expect(normalizeModelName('claude-sonnet-4-6')).toBe('claude-sonnet-4.6');
  });

  it('strips date suffix', () => {
    expect(normalizeModelName('claude-sonnet-4-20250514')).toBe('claude-sonnet-4');
  });

  it('handles haiku with minor version and date', () => {
    expect(normalizeModelName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5');
  });

  it('handles opus with minor version', () => {
    expect(normalizeModelName('claude-opus-4-6')).toBe('claude-opus-4.6');
  });

  it('passes through already-normalized names', () => {
    expect(normalizeModelName('claude-sonnet-4.6')).toBe('claude-sonnet-4.6');
  });

  it('passes through unknown models', () => {
    expect(normalizeModelName('gpt-4o')).toBe('gpt-4o');
  });

  it('handles major-only without date', () => {
    expect(normalizeModelName('claude-sonnet-4')).toBe('claude-sonnet-4');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Code/kiro-pool-proxy && npx vitest run tests/model-map.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement model-map.ts**

```typescript
/**
 * Normalizes Anthropic model names to Kiro/CodeWhisperer format.
 *
 * Examples:
 *   claude-sonnet-4-6       → claude-sonnet-4.6
 *   claude-haiku-4-5-20251001 → claude-haiku-4.5
 *   claude-sonnet-4-20250514  → claude-sonnet-4
 *   claude-sonnet-4           → claude-sonnet-4
 */
export function normalizeModelName(name: string): string {
  // Pattern: claude-{family}-{major}-{minor}(-{date|latest})?
  // Minor is 1-2 digits only (not 8-digit dates)
  const withMinor = /^(claude-(?:haiku|sonnet|opus)-\d+)-(\d{1,2})(?:-(?:\d{8}|latest))?$/;
  const m1 = withMinor.exec(name);
  if (m1) return `${m1[1]}.${m1[2]}`;

  // Pattern: claude-{family}-{major}(-{date})?
  const noMinor = /^(claude-(?:haiku|sonnet|opus)-\d+)(?:-\d{8})?$/;
  const m2 = noMinor.exec(name);
  if (m2) return m2[1];

  // Already normalized or unknown — pass through
  return name;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Code/kiro-pool-proxy && npx vitest run tests/model-map.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Code/kiro-pool-proxy && git add src/proxy/model-map.ts tests/model-map.test.ts && git commit -m "feat: model name normalization (Anthropic → Kiro format)"
```

---

## Task 4: Request conversion (Anthropic → CodeWhisperer)

This is the core format converter. It transforms an Anthropic Messages API request body into a CodeWhisperer `generateAssistantResponse` request body. Pure function, no I/O.

**Files:**
- Create: `~/Code/kiro-pool-proxy/src/proxy/convert-request.ts`
- Create: `~/Code/kiro-pool-proxy/tests/convert-request.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { convertRequest } from '../src/proxy/convert-request.js';
import type { AnthropicRequest } from '../src/proxy/types.js';

describe('convertRequest', () => {
  const profileArn = 'arn:aws:codewhisperer:us-east-1:123:profile/TEST';

  it('converts a simple text message', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-4.6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const cw = convertRequest(req, profileArn);
    expect(cw.profileArn).toBe(profileArn);
    expect(cw.conversationState.currentMessage.userInputMessage.content).toBe('Hello');
    expect(cw.conversationState.currentMessage.userInputMessage.modelId).toBe('claude-sonnet-4.6');
    expect(cw.conversationState.currentMessage.userInputMessage.origin).toBe('AI_EDITOR');
    expect(cw.conversationState.history).toBeUndefined();
  });

  it('converts system prompt into first user message content', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-4.6',
      max_tokens: 8192,
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    };
    const cw = convertRequest(req, profileArn);
    expect(cw.conversationState.currentMessage.userInputMessage.content).toContain('You are helpful.');
    expect(cw.conversationState.currentMessage.userInputMessage.content).toContain('Hello');
  });

  it('converts system block array', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-4.6',
      max_tokens: 8192,
      system: [{ type: 'text', text: 'Be concise.' }],
      messages: [{ role: 'user', content: 'Hi' }],
    };
    const cw = convertRequest(req, profileArn);
    expect(cw.conversationState.currentMessage.userInputMessage.content).toContain('Be concise.');
  });

  it('builds history from multi-turn conversation', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-4.6',
      max_tokens: 8192,
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'And 3+3?' },
      ],
    };
    const cw = convertRequest(req, profileArn);
    expect(cw.conversationState.history).toHaveLength(2);
    expect(cw.conversationState.history![0].userInputMessage?.content).toBe('What is 2+2?');
    expect(cw.conversationState.history![1].assistantResponseMessage?.content).toBe('4');
    expect(cw.conversationState.currentMessage.userInputMessage.content).toBe('And 3+3?');
  });

  it('converts tools to toolSpecification format', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-4.6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'Read file' }],
      tools: [{
        name: 'Read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
    };
    const cw = convertRequest(req, profileArn);
    const ctx = cw.conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(ctx?.tools).toHaveLength(1);
    expect(ctx!.tools![0].toolSpecification.name).toBe('Read');
    expect(ctx!.tools![0].toolSpecification.inputSchema.json).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
  });

  it('converts tool_result content blocks to toolResults', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-4.6',
      max_tokens: 8192,
      messages: [
        { role: 'user', content: 'Read file' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/tmp/x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents here' }] },
      ],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
    };
    const cw = convertRequest(req, profileArn);
    const ctx = cw.conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(ctx?.toolResults).toHaveLength(1);
    expect(ctx!.toolResults![0].toolUseId).toBe('tu_1');
    expect(ctx!.toolResults![0].content[0].text).toBe('file contents here');
  });

  it('handles content as array of text blocks', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-4.6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }] }],
    };
    const cw = convertRequest(req, profileArn);
    expect(cw.conversationState.currentMessage.userInputMessage.content).toBe('Hello world');
  });

  it('extracts tool_use from assistant history into toolUses', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-4.6',
      max_tokens: 8192,
      messages: [
        { role: 'user', content: 'List files' },
        { role: 'assistant', content: [
          { type: 'text', text: 'Listing...' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        ]},
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file1.txt' }] },
      ],
      tools: [{ name: 'Bash', description: 'Run command', input_schema: { type: 'object' } }],
    };
    const cw = convertRequest(req, profileArn);
    const assistantEntry = cw.conversationState.history![1];
    expect(assistantEntry.assistantResponseMessage?.toolUses).toHaveLength(1);
    expect(assistantEntry.assistantResponseMessage!.toolUses![0].name).toBe('Bash');
  });

  it('sanitizes additionalProperties and empty required from tool schemas', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-4.6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'test' }],
      tools: [{
        name: 'T',
        description: 'test',
        input_schema: { type: 'object', additionalProperties: false, required: [], properties: { x: { type: 'string' } } },
      }],
    };
    const cw = convertRequest(req, profileArn);
    const schema = cw.conversationState.currentMessage.userInputMessage.userInputMessageContext!.tools![0].toolSpecification.inputSchema.json;
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(schema).not.toHaveProperty('required');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Code/kiro-pool-proxy && npx vitest run tests/convert-request.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement convert-request.ts**

```typescript
import type {
  AnthropicRequest,
  AnthropicContentBlock,
  AnthropicSystemBlock,
  CWRequest,
  CWHistoryEntry,
  CWToolSpecification,
  CWToolResult,
  CWUserInputMessage,
} from './types.js';
import { randomUUID } from 'node:crypto';

/** Extract plain text from Anthropic content (string or content block array). */
function extractText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** Extract system prompt text from string or block array. */
function extractSystemPrompt(system: string | AnthropicSystemBlock[] | undefined): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n');
}

/** Remove additionalProperties and empty required[] from JSON schemas recursively. */
function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;
    if (key === 'required' && Array.isArray(value) && value.length === 0) continue;
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          typeof v === 'object' && v !== null ? sanitizeSchema(v as Record<string, unknown>) : v,
        ]),
      );
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeSchema(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'object' && item !== null ? sanitizeSchema(item as Record<string, unknown>) : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Convert Anthropic tools to CodeWhisperer toolSpecification format. */
function convertTools(tools: AnthropicRequest['tools']): CWToolSpecification[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    toolSpecification: {
      name: t.name,
      description: t.description || `Tool: ${t.name}`,
      inputSchema: { json: sanitizeSchema(t.input_schema) },
    },
  }));
}

/** Extract tool_result blocks from a user message's content. */
function extractToolResults(content: string | AnthropicContentBlock[]): CWToolResult[] | undefined {
  if (typeof content === 'string') return undefined;
  const results = content
    .filter((b) => b.type === 'tool_result')
    .map((b) => {
      let text = '';
      if (typeof b.content === 'string') {
        text = b.content;
      } else if (Array.isArray(b.content)) {
        text = b.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      }
      return {
        content: [{ text: text || '(empty result)' }],
        status: 'success' as const,
        toolUseId: b.tool_use_id ?? '',
      };
    });
  return results.length > 0 ? results : undefined;
}

/** Extract tool_use blocks from an assistant message's content into CW toolUses. */
function extractToolUses(content: string | AnthropicContentBlock[]): { toolUseId: string; name: string; input: unknown }[] | undefined {
  if (typeof content === 'string') return undefined;
  const uses = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      toolUseId: b.id ?? '',
      name: b.name ?? '',
      input: b.input ?? {},
    }));
  return uses.length > 0 ? uses : undefined;
}

/**
 * Convert an Anthropic Messages API request to a CodeWhisperer generateAssistantResponse request.
 */
export function convertRequest(req: AnthropicRequest, profileArn: string): CWRequest {
  const modelId = req.model;
  const systemPrompt = extractSystemPrompt(req.system);
  const messages = req.messages;

  if (messages.length === 0) {
    throw new Error('No messages in request');
  }

  // Split into history (all but last) and current (last)
  const historyMsgs = messages.slice(0, -1);
  const currentMsg = messages[messages.length - 1];

  // Build current message content, prepending system prompt if no history
  let currentContent = extractText(currentMsg.content);
  if (systemPrompt && historyMsgs.length === 0) {
    currentContent = `${systemPrompt}\n\n${currentContent}`;
  }

  // Build userInputMessageContext
  const ctx: CWUserInputMessage['userInputMessageContext'] = {};
  const cwTools = convertTools(req.tools);
  if (cwTools) ctx.tools = cwTools;
  const toolResults = extractToolResults(currentMsg.content);
  if (toolResults) ctx.toolResults = toolResults;

  const userInputMessage: CWUserInputMessage = {
    content: currentContent || 'Continue',
    modelId,
    origin: 'AI_EDITOR',
    ...(Object.keys(ctx).length > 0 ? { userInputMessageContext: ctx } : {}),
  };

  // Build history
  let history: CWHistoryEntry[] | undefined;
  if (historyMsgs.length > 0) {
    history = [];

    // If system prompt exists and there's history, prepend to first user message
    let systemPrepended = false;

    for (const msg of historyMsgs) {
      if (msg.role === 'user') {
        let content = extractText(msg.content);
        if (systemPrompt && !systemPrepended) {
          content = `${systemPrompt}\n\n${content}`;
          systemPrepended = true;
        }

        const userInput: CWUserInputMessage = {
          content: content || '(empty)',
          modelId,
          origin: 'AI_EDITOR',
        };

        // Add tool results from user messages in history
        const historyToolResults = extractToolResults(msg.content);
        if (historyToolResults) {
          userInput.userInputMessageContext = { toolResults: historyToolResults };
        }

        history.push({ userInputMessage: userInput });
      } else if (msg.role === 'assistant') {
        const content = extractText(msg.content);
        const toolUses = extractToolUses(msg.content);
        history.push({
          assistantResponseMessage: {
            content: content || '(empty)',
            ...(toolUses ? { toolUses } : {}),
          },
        });
      }
    }
  }

  return {
    profileArn,
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: randomUUID(),
      currentMessage: { userInputMessage },
      ...(history && history.length > 0 ? { history } : {}),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Code/kiro-pool-proxy && npx vitest run tests/convert-request.test.ts
```

Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Code/kiro-pool-proxy && git add src/proxy/convert-request.ts tests/convert-request.test.ts && git commit -m "feat: Anthropic → CodeWhisperer request conversion"
```

---

## Task 5: Response stream conversion (AWS binary event stream → Anthropic SSE)

CodeWhisperer returns `application/vnd.amazon.eventstream` — a binary format where each frame has a 4-byte total length, 4-byte header length, headers, and a JSON payload. The JSON payloads contain `{"content": "..."}` for text, `{"name": "...", "toolUseId": "...", "input": "..."}` for tool starts, `{"input": "..."}` for tool input continuation, `{"stop": true}` for tool end, and `{"contextUsagePercentage": N}` for usage.

**Files:**
- Create: `~/Code/kiro-pool-proxy/src/proxy/convert-response.ts`
- Create: `~/Code/kiro-pool-proxy/tests/convert-response.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { AwsEventStreamParser, formatSSE, buildMessageStart, buildMessageDelta, buildMessageStop } from '../src/proxy/convert-response.js';

describe('AwsEventStreamParser', () => {
  it('parses a content event from JSON string', () => {
    const parser = new AwsEventStreamParser();
    const chunk = Buffer.from('{"content":"Hello"}');
    const events = parser.feed(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('content');
    expect(events[0].data).toBe('Hello');
  });

  it('parses tool_start event', () => {
    const parser = new AwsEventStreamParser();
    const chunk = Buffer.from('{"name":"Bash","toolUseId":"tu_1","input":"{\\"command\\":\\"ls\\"}","stop":true}');
    const events = parser.feed(chunk);
    const tools = parser.getToolCalls();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Bash');
    expect(tools[0].id).toBe('tu_1');
  });

  it('parses contextUsagePercentage event', () => {
    const parser = new AwsEventStreamParser();
    const chunk = Buffer.from('{"contextUsagePercentage":42.5}');
    const events = parser.feed(chunk);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('context_usage');
    expect(events[0].data).toBe(42.5);
  });

  it('deduplicates repeated content', () => {
    const parser = new AwsEventStreamParser();
    parser.feed(Buffer.from('{"content":"A"}'));
    const events = parser.feed(Buffer.from('{"content":"A"}'));
    expect(events).toHaveLength(0);
  });

  it('handles multiple events in one chunk', () => {
    const parser = new AwsEventStreamParser();
    const chunk = Buffer.from('{"content":"A"}{"content":"B"}');
    const events = parser.feed(chunk);
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe('A');
    expect(events[1].data).toBe('B');
  });

  it('handles partial JSON across chunks', () => {
    const parser = new AwsEventStreamParser();
    const events1 = parser.feed(Buffer.from('{"conte'));
    expect(events1).toHaveLength(0);
    const events2 = parser.feed(Buffer.from('nt":"Split"}'));
    expect(events2).toHaveLength(1);
    expect(events2[0].data).toBe('Split');
  });
});

describe('formatSSE', () => {
  it('formats event type and JSON data', () => {
    const result = formatSSE('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } });
    expect(result).toBe('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n');
  });
});

describe('message envelope helpers', () => {
  it('buildMessageStart returns correct structure', () => {
    const start = buildMessageStart('msg_123', 'claude-sonnet-4.6', 100);
    expect(start.message.id).toBe('msg_123');
    expect(start.message.model).toBe('claude-sonnet-4.6');
    expect(start.message.usage.input_tokens).toBe(100);
  });

  it('buildMessageDelta returns correct stop_reason', () => {
    const delta = buildMessageDelta('end_turn', 50);
    expect(delta.delta.stop_reason).toBe('end_turn');
    expect(delta.usage.output_tokens).toBe(50);
  });

  it('buildMessageStop is correct type', () => {
    expect(buildMessageStop().type).toBe('message_stop');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Code/kiro-pool-proxy && npx vitest run tests/convert-response.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement convert-response.ts**

```typescript
import { randomUUID } from 'node:crypto';

// --- Event types ---

export interface ParsedEvent {
  type: 'content' | 'tool_start' | 'tool_input' | 'tool_stop' | 'usage' | 'context_usage';
  data: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

// --- SSE formatting ---

export function formatSSE(eventType: string, data: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function buildMessageStart(messageId: string, model: string, inputTokens: number) {
  return {
    type: 'message_start' as const,
    message: {
      id: messageId,
      type: 'message' as const,
      role: 'assistant' as const,
      content: [] as unknown[],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  };
}

export function buildMessageDelta(stopReason: string, outputTokens: number) {
  return {
    type: 'message_delta' as const,
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };
}

export function buildMessageStop() {
  return { type: 'message_stop' as const };
}

// --- AWS Event Stream Parser ---

const EVENT_PATTERNS: [string, ParsedEvent['type']][] = [
  ['{"content":', 'content'],
  ['{"name":', 'tool_start'],
  ['{"input":', 'tool_input'],
  ['{"stop":', 'tool_stop'],
  ['{"usage":', 'usage'],
  ['{"contextUsagePercentage":', 'context_usage'],
];

function findMatchingBrace(text: string, start: number): number {
  if (start >= text.length || text[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return i; }
    }
  }
  return -1;
}

/**
 * Parses the AWS binary event stream from CodeWhisperer.
 *
 * The stream mixes binary framing with JSON payloads. We scan the UTF-8 text
 * for known JSON patterns — the same approach used by kiro-gateway's
 * AwsEventStreamParser (parsers.py).
 */
export class AwsEventStreamParser {
  private buffer = '';
  private lastContent: string | null = null;
  private currentToolCall: { id: string; name: string; arguments: string } | null = null;
  private toolCalls: ToolCall[] = [];

  feed(chunk: Buffer): ParsedEvent[] {
    this.buffer += chunk.toString('utf-8');
    const events: ParsedEvent[] = [];

    while (true) {
      let earliestPos = -1;
      let earliestType: ParsedEvent['type'] | null = null;

      for (const [pattern, type] of EVENT_PATTERNS) {
        const pos = this.buffer.indexOf(pattern);
        if (pos !== -1 && (earliestPos === -1 || pos < earliestPos)) {
          earliestPos = pos;
          earliestType = type;
        }
      }

      if (earliestPos === -1 || earliestType === null) break;

      const jsonEnd = findMatchingBrace(this.buffer, earliestPos);
      if (jsonEnd === -1) break;

      const jsonStr = this.buffer.slice(earliestPos, jsonEnd + 1);
      this.buffer = this.buffer.slice(jsonEnd + 1);

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        continue;
      }

      const event = this.processEvent(data, earliestType);
      if (event) events.push(event);
    }

    return events;
  }

  private processEvent(data: Record<string, unknown>, type: ParsedEvent['type']): ParsedEvent | null {
    switch (type) {
      case 'content': {
        const content = data.content as string;
        if (content === this.lastContent) return null;
        this.lastContent = content;
        return { type: 'content', data: content };
      }
      case 'tool_start': {
        if (this.currentToolCall) this.finalizeToolCall();
        const input = typeof data.input === 'object' ? JSON.stringify(data.input) : String(data.input ?? '');
        this.currentToolCall = {
          id: (data.toolUseId as string) || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          name: (data.name as string) || '',
          arguments: input,
        };
        if (data.stop) this.finalizeToolCall();
        return null;
      }
      case 'tool_input': {
        if (this.currentToolCall) {
          const input = typeof data.input === 'object' ? JSON.stringify(data.input) : String(data.input ?? '');
          this.currentToolCall.arguments += input;
        }
        return null;
      }
      case 'tool_stop': {
        if (this.currentToolCall && data.stop) this.finalizeToolCall();
        return null;
      }
      case 'usage':
        return { type: 'usage', data: data.usage };
      case 'context_usage':
        return { type: 'context_usage', data: data.contextUsagePercentage };
    }
    return null;
  }

  private finalizeToolCall(): void {
    if (!this.currentToolCall) return;
    let args = this.currentToolCall.arguments;
    if (args) {
      try { args = JSON.stringify(JSON.parse(args)); } catch { args = '{}'; }
    } else {
      args = '{}';
    }
    this.toolCalls.push({ ...this.currentToolCall, arguments: args });
    this.currentToolCall = null;
  }

  getToolCalls(): ToolCall[] {
    if (this.currentToolCall) this.finalizeToolCall();
    return this.toolCalls;
  }

  reset(): void {
    this.buffer = '';
    this.lastContent = null;
    this.currentToolCall = null;
    this.toolCalls = [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Code/kiro-pool-proxy && npx vitest run tests/convert-response.test.ts
```

Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Code/kiro-pool-proxy && git add src/proxy/convert-response.ts tests/convert-response.test.ts && git commit -m "feat: AWS event stream parser and Anthropic SSE formatter"
```

---

## Task 6: Proxy request handler

Glue that ties account selection, request conversion, HTTP dispatch to CodeWhisperer, response stream parsing, and SSE output together.

**Files:**
- Create: `~/Code/kiro-pool-proxy/src/proxy/handler.ts`

- [ ] **Step 1: Implement handler.ts**

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import { selectAccount, recordSuccess, recordAuthFailure, recordRateLimit } from '../lib/accounts.js';
import { getPool, loadConfig } from '../lib/config.js';
import { convertRequest } from './convert-request.js';
import { normalizeModelName } from './model-map.js';
import { AwsEventStreamParser, formatSSE, buildMessageStart, buildMessageDelta, buildMessageStop } from './convert-response.js';
import type { AnthropicRequest } from './types.js';
import { randomUUID } from 'node:crypto';

const CW_HEADERS = {
  'Content-Type': 'application/x-amz-json-1.1',
  'X-Amz-Target': 'CodeWhispererService.GenerateAssistantResponse',
  'User-Agent': 'kiro-pool-proxy/1.0',
};

/**
 * Handle a POST /v1/messages request.
 *
 * 1. Parse the Anthropic request body
 * 2. Extract pool name from model prefix (e.g., "trackable:claude-sonnet-4-6")
 * 3. Select best account from pool
 * 4. Convert request to CodeWhisperer format
 * 5. Send to CodeWhisperer API
 * 6. Stream back as Anthropic SSE
 */
export async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body: AnthropicRequest = JSON.parse(Buffer.concat(chunks).toString());

  // Parse pool from model prefix
  const rawModel = body.model;
  let poolName: string;
  let modelName: string;

  if (rawModel.includes(':')) {
    const colonIdx = rawModel.indexOf(':');
    poolName = rawModel.slice(0, colonIdx);
    modelName = rawModel.slice(colonIdx + 1);
  } else {
    const config = loadConfig();
    poolName = Object.keys(config.pools)[0];
    modelName = rawModel;
  }

  const normalizedModel = normalizeModelName(modelName);

  // Validate pool exists
  let pool;
  try {
    pool = getPool(poolName);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: (err as Error).message } }));
    return;
  }

  // Select account
  let account;
  try {
    account = await selectAccount(poolName);
  } catch (err) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: (err as Error).message } }));
    return;
  }

  // Convert request
  const cwBody = convertRequest(
    { ...body, model: normalizedModel },
    account.profile_arn,
  );

  const cwUrl = `https://codewhisperer.${account.region}.amazonaws.com/generateAssistantResponse`;
  console.log(`[proxy] ${poolName}/${account.email} → ${normalizedModel} (${cwUrl})`);

  // Send to CodeWhisperer
  let cwRes: Response;
  try {
    cwRes = await fetch(cwUrl, {
      method: 'POST',
      headers: { ...CW_HEADERS, Authorization: `Bearer ${account.access_token}` },
      body: JSON.stringify(cwBody),
    });
  } catch (err) {
    console.error(`[proxy] fetch error: ${err}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Upstream error: ${err}` } }));
    return;
  }

  if (!cwRes.ok) {
    const errText = await cwRes.text().catch(() => '');
    console.error(`[proxy] CodeWhisperer ${cwRes.status}: ${errText.slice(0, 200)}`);
    if (cwRes.status === 429) recordRateLimit(account.id);
    else if (cwRes.status === 401 || cwRes.status === 403) recordAuthFailure(account.id);
    res.writeHead(cwRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `CodeWhisperer ${cwRes.status}: ${errText.slice(0, 500)}` } }));
    return;
  }

  recordSuccess(account.id);

  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  if (body.stream === false) {
    await handleNonStreaming(cwRes, res, messageId, normalizedModel);
  } else {
    await handleStreaming(cwRes, res, messageId, normalizedModel);
  }
}

async function handleStreaming(cwRes: Response, res: ServerResponse, messageId: string, model: string): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(formatSSE('message_start', buildMessageStart(messageId, model, 0)));

  const parser = new AwsEventStreamParser();
  let textBlockStarted = false;
  let blockIndex = 0;
  let fullContent = '';

  const reader = cwRes.body?.getReader();
  if (!reader) {
    res.write(formatSSE('error', { type: 'error', error: { type: 'api_error', message: 'No response body' } }));
    res.end();
    return;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const events = parser.feed(Buffer.from(value));
      for (const event of events) {
        if (event.type === 'content') {
          const content = event.data as string;
          fullContent += content;

          if (!textBlockStarted) {
            res.write(formatSSE('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } }));
            textBlockStarted = true;
          }

          res.write(formatSSE('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: content } }));
        }
      }
    }

    if (textBlockStarted) {
      res.write(formatSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
      blockIndex++;
    }

    const toolCalls = parser.getToolCalls();
    for (const tc of toolCalls) {
      res.write(formatSSE('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } }));
      res.write(formatSSE('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: tc.arguments } }));
      res.write(formatSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
      blockIndex++;
    }

    const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    const outputTokens = Math.max(1, Math.floor(fullContent.length / 4));
    res.write(formatSSE('message_delta', buildMessageDelta(stopReason, outputTokens)));
    res.write(formatSSE('message_stop', buildMessageStop()));
  } catch (err) {
    console.error(`[proxy] stream error: ${err}`);
    res.write(formatSSE('error', { type: 'error', error: { type: 'api_error', message: String(err) } }));
  } finally {
    res.end();
  }
}

async function handleNonStreaming(cwRes: Response, res: ServerResponse, messageId: string, model: string): Promise<void> {
  const parser = new AwsEventStreamParser();
  let fullContent = '';

  const reader = cwRes.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const events = parser.feed(Buffer.from(value));
      for (const event of events) {
        if (event.type === 'content') fullContent += event.data as string;
      }
    }
  }

  const toolCalls = parser.getToolCalls();
  const contentBlocks: Record<string, unknown>[] = [];
  if (fullContent) contentBlocks.push({ type: 'text', text: fullContent });
  for (const tc of toolCalls) {
    let input: unknown = {};
    try { input = JSON.parse(tc.arguments); } catch { /* keep empty */ }
    contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }

  const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
  const outputTokens = Math.max(1, Math.floor(fullContent.length / 4));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: messageId, type: 'message', role: 'assistant', content: contentBlocks, model,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 0, output_tokens: outputTokens },
  }));
}
```

- [ ] **Step 2: Build and verify no type errors**

```bash
cd ~/Code/kiro-pool-proxy && pnpm build
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd ~/Code/kiro-pool-proxy && git add src/proxy/handler.ts && git commit -m "feat: proxy request handler (account selection → CW dispatch → SSE streaming)"
```

---

## Task 7: HTTP server and CLI integration

**Files:**
- Create: `~/Code/kiro-pool-proxy/src/server.ts`
- Modify: `~/Code/kiro-pool-proxy/src/cli.ts`
- Modify: `~/Code/kiro-pool-proxy/src/lib/config.ts`
- Modify: `~/Code/kiro-pool-proxy/config.json`

- [ ] **Step 1: Add port to config**

In `src/lib/config.ts`, add `port` to the `Config` interface:

```typescript
export interface Config {
  pools: Record<string, PoolConfig>;
  dbPath: string;
  selectionStrategy: 'lowest-usage' | 'round-robin';
  tokenExpiryBufferMs: number;
  port: number;
}
```

And in `loadConfig()`, add `port` to the cached object:

```typescript
  cached = {
    pools: raw.pools,
    dbPath: expandHome(raw.dbPath ?? '~/.config/kiro-auth/accounts.db'),
    selectionStrategy: raw.selectionStrategy ?? 'lowest-usage',
    tokenExpiryBufferMs: raw.tokenExpiryBufferMs ?? 300_000,
    port: raw.port ?? 3457,
  };
```

- [ ] **Step 2: Add port to config.json**

```json
{
  "pools": {
    "trackable": {
      "startUrl": "https://trackable.awsapps.com/start",
      "profileArn": "arn:aws:codewhisperer:us-east-1:547025169931:profile/WKEWWQMKGKVC",
      "oidcRegion": "us-east-2",
      "serviceRegion": "us-east-1"
    },
    "okkanti": {
      "startUrl": "https://d-90660512b0.awsapps.com/start",
      "profileArn": "arn:aws:codewhisperer:us-east-1:313941174970:profile/Y7VYR77U33DE",
      "oidcRegion": "us-east-1",
      "serviceRegion": "us-east-1"
    }
  },
  "port": 3457,
  "dbPath": "~/.config/kiro-auth/accounts.db",
  "selectionStrategy": "lowest-usage",
  "tokenExpiryBufferMs": 300000
}
```

- [ ] **Step 3: Create server.ts**

```typescript
import { createServer } from 'node:http';
import { loadConfig } from './lib/config.js';
import { handleMessages } from './proxy/handler.js';

export function startServer(port?: number): void {
  const config = loadConfig();
  const listenPort = port ?? config.port;

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/messages') {
      try {
        await handleMessages(req, res);
      } catch (err) {
        console.error(`[server] unhandled error: ${err}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }));
        }
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(listenPort, '127.0.0.1', () => {
    console.log(`[kiro-pool-proxy] listening on http://127.0.0.1:${listenPort}`);
    console.log(`[kiro-pool-proxy] POST /v1/messages — Anthropic Messages API → CodeWhisperer`);
  });
}

// Allow running directly: node dist/server.js
const isDirectRun = process.argv[1]?.endsWith('server.js');
if (isDirectRun) {
  startServer();
}
```

- [ ] **Step 4: Add serve command to CLI**

In `src/cli.ts`, add the `serve` case after the `refresh` case in the switch:

```typescript
    case 'serve': {
      const port = args._[1] ? parseInt(args._[1], 10) : undefined;
      const { startServer } = await import('./server.js');
      startServer(port);
      break;
    }
```

And update the help text default case to:

```typescript
    default:
      console.log(`kiro-pool-proxy — Kiro multi-account proxy for Claude Code

Commands:
  login <pool>          Add an account to a pool via browser login
  status                Show all pools and account health
  logout <pool> [email] Remove an account from a pool
  refresh [pool]        Manually refresh tokens
  serve [port]          Start the proxy server (default: port from config)`);
      if (command && command !== 'help') {
        console.error(`\nUnknown command: ${command}`);
        process.exit(1);
      }
```

- [ ] **Step 5: Build and start the server**

```bash
cd ~/Code/kiro-pool-proxy && pnpm build && node dist/server.js
```

Expected: `[kiro-pool-proxy] listening on http://127.0.0.1:3457`

Stop with Ctrl+C after verifying.

- [ ] **Step 6: Commit**

```bash
cd ~/Code/kiro-pool-proxy && git add src/server.ts src/cli.ts src/lib/config.ts config.json && git commit -m "feat: HTTP server with serve command and configurable port"
```

---

## Task 8: End-to-end smoke test

Test the full flow: proxy receives Anthropic request → converts → sends to CodeWhisperer → streams back.

**Files:** No new files — manual testing.

- [ ] **Step 1: Refresh tokens (they may have expired)**

```bash
cd ~/Code/kiro-pool-proxy && node dist/cli.js refresh
```

- [ ] **Step 2: Start the proxy in background**

```bash
cd ~/Code/kiro-pool-proxy && node dist/server.js &
```

- [ ] **Step 3: Send a simple streaming request via curl**

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: not-needed" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "trackable:claude-sonnet-4-6",
    "max_tokens": 256,
    "stream": true,
    "messages": [{"role": "user", "content": "Say hello in exactly 5 words."}]
  }'
```

Expected: SSE events including `event: message_start`, `event: content_block_start`, multiple `event: content_block_delta` with `text_delta`, `event: content_block_stop`, `event: message_delta`, `event: message_stop`.

- [ ] **Step 4: Send a non-streaming request**

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "okkanti:claude-sonnet-4-6",
    "max_tokens": 256,
    "stream": false,
    "messages": [{"role": "user", "content": "What is 2+2? Reply with just the number."}]
  }' | python3 -m json.tool
```

Expected: JSON response with `type: "message"`, `content: [{type: "text", text: "4"}]`, `stop_reason: "end_turn"`.

- [ ] **Step 5: Kill the background server**

```bash
kill %1 2>/dev/null || true
```

- [ ] **Step 6: Commit any fixes found during testing**

If any fixes were needed, commit them now.

---

## Task 9: Orchestrel SessionManager update

Update Orchestrel's SessionManager to point at the proxy instead of CCR.

**Files:**
- Modify: `~/Code/orchestrel/.worktrees/claude-agent-sdk/src/server/sessions/manager.ts`

- [ ] **Step 1: Verify current SessionManager code**

Read `src/server/sessions/manager.ts` in the orchestrel worktree. The relevant env block (around line 43) should already have:

```typescript
...(isKiroProvider ? { ANTHROPIC_BASE_URL: process.env.CCR_URL ?? 'http://127.0.0.1:3457' } : {}),
```

This is already correct — it sends `trackable:claude-sonnet-4-6` as the model and sets `ANTHROPIC_BASE_URL` to port 3457. The proxy handles the prefix parsing. No code change needed in SessionManager if we keep the same port.

- [ ] **Step 2: Rename the env variable for clarity**

In `manager.ts`, change `CCR_URL` to `KIRO_PROXY_URL`:

```typescript
...(isKiroProvider ? { ANTHROPIC_BASE_URL: process.env.KIRO_PROXY_URL ?? 'http://127.0.0.1:3457' } : {}),
```

- [ ] **Step 3: Build orchestrel to verify**

```bash
cd ~/Code/orchestrel/.worktrees/claude-agent-sdk && pnpm build
```

- [ ] **Step 4: Commit in orchestrel**

```bash
cd ~/Code/orchestrel/.worktrees/claude-agent-sdk && git add src/server/sessions/manager.ts && git commit -m "refactor: rename CCR_URL to KIRO_PROXY_URL (kiro-pool-proxy replaces CCR)"
```

---

## Task 10: Systemd service for the proxy

**Files:**
- Create: `~/Code/kiro-pool-proxy/kiro-pool-proxy.service`

- [ ] **Step 1: Create systemd unit file**

```ini
[Unit]
Description=Kiro Pool Proxy — Anthropic API → CodeWhisperer with multi-account pooling
After=network.target

[Service]
Type=simple
User=ryan
WorkingDirectory=/home/ryan/Code/kiro-pool-proxy
ExecStart=/usr/bin/node /home/ryan/Code/kiro-pool-proxy/dist/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Install and enable**

```bash
sudo cp ~/Code/kiro-pool-proxy/kiro-pool-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable kiro-pool-proxy
sudo systemctl start kiro-pool-proxy
sudo systemctl status kiro-pool-proxy
```

Expected: Active (running), logs show `listening on http://127.0.0.1:3457`.

- [ ] **Step 3: Verify it works through systemd**

```bash
curl -s http://127.0.0.1:3457/health | python3 -m json.tool
```

Expected: `{"status": "ok"}`

- [ ] **Step 4: Commit**

```bash
cd ~/Code/kiro-pool-proxy && git add kiro-pool-proxy.service && git commit -m "ops: add systemd service unit"
```

---

## Task 11: Clean up CCR

Since CCR is no longer needed, remove the global CCR install and archive the config.

- [ ] **Step 1: Stop and disable CCR if running**

```bash
pgrep -f claude-code-router && echo "CCR is running" || echo "CCR not running"
sudo systemctl stop claude-code-router 2>/dev/null || true
sudo systemctl disable claude-code-router 2>/dev/null || true
```

- [ ] **Step 2: Uninstall CCR**

```bash
npm uninstall -g @musistudio/claude-code-router
```

- [ ] **Step 3: Archive CCR config (don't delete — might be useful later)**

```bash
mv ~/.claude-code-router/config.json ~/.claude-code-router/config.json.bak 2>/dev/null || true
```
