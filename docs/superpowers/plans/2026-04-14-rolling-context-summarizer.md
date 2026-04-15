# Rolling Context Summarizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Pi framework's dumb sawtooth eviction with a background summarization-based rolling context window that preserves information instead of dropping it.

**Architecture:** When context usage crosses a configurable threshold (per-card, as % of context window), the extension kicks off a background DeepSeek V3 call via OpenRouter to summarize the oldest half of messages. The agent keeps working unblocked. When the summary returns, it replaces the oldest messages with a single summary user message. The threshold is adjustable per card (0 = disabled), allowing gradual testing during normal work.

**Tech Stack:** Pi framework extensions (`context` + `turn_end` events), OpenRouter API (OpenAI-compatible chat completions), DeepSeek V3 (`deepseek/deepseek-chat-v3-0324`), vitest for tests.

**Branch:** `pi-framework-evaluation-for-orchestrel` (the pi migration branch)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/orcd/extensions/summarizer.ts` | Pi extension: triggers background summarization, splices summary into messages on next `context` event |
| `src/orcd/extensions/summarizer-client.ts` | OpenRouter API client: sends excerpt to model, returns summary text |
| `src/orcd/__tests__/summarizer.test.ts` | Unit tests for the extension (trigger logic, message splicing, state machine) |
| `src/orcd/__tests__/summarizer-client.test.ts` | Unit tests for the API client (request format, response parsing, error handling) |
| `src/shared/constants.ts` | Add `DEFAULT_SUMMARIZE_THRESHOLD` constant |
| `src/shared/orcd-protocol.ts` | Add `summarizeThreshold` to `CreateAction` |
| `src/orcd/pi-session.ts` | Wire the new extension into the session, pass threshold from protocol |
| `src/orcd/types.ts` | Add `summarizeThreshold` to `PiSessionOptions` |
| `src/server/models/Card.ts` | Add `summarizeThreshold` column |
| `src/server/controllers/card-sessions.ts` | Pass `summarizeThreshold` from card to orcd `create` action |
| `src/shared/ws-protocol.ts` | Add `summarizeThreshold` to card/cardCreate/cardUpdate zod schemas |

---

### Task 1: Summarizer API Client

**Files:**
- Create: `src/orcd/extensions/summarizer-client.ts`
- Test: `src/orcd/__tests__/summarizer-client.test.ts`

This is a standalone module that calls OpenRouter's chat completions API with a conversation excerpt and returns a summary string. No Pi framework dependency — pure async function.

- [ ] **Step 1: Write the failing test for successful summarization**

```typescript
// src/orcd/__tests__/summarizer-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { summarizeExcerpt, type SummarizerConfig } from '../extensions/summarizer-client';

const MOCK_CONFIG: SummarizerConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-test-key',
  model: 'deepseek/deepseek-chat-v3-0324',
  maxTokens: 8192,
  temperature: 0.3,
};

describe('summarizeExcerpt', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends correct request and returns summary text', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '# Summary\nKey decisions...' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
      }),
    });

    const result = await summarizeExcerpt('conversation text here', MOCK_CONFIG);

    expect(result.summary).toBe('# Summary\nKey decisions...');
    expect(result.usage).toEqual({ promptTokens: 1000, completionTokens: 200 });

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.model).toBe('deepseek/deepseek-chat-v3-0324');
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(0.3);
    expect((body.messages as Array<{ role: string }>)[0].role).toBe('system');
    expect((body.messages as Array<{ role: string }>)[1].role).toBe('user');
  });

  it('throws on non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });

    await expect(summarizeExcerpt('text', MOCK_CONFIG))
      .rejects.toThrow('Summarizer API 429: rate limited');
  });

  it('throws on empty choices', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    await expect(summarizeExcerpt('text', MOCK_CONFIG))
      .rejects.toThrow('Summarizer returned no content');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orcd/__tests__/summarizer-client.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write the implementation**

```typescript
// src/orcd/extensions/summarizer-client.ts

const LOG = '[summarizer]';

const SYSTEM_PROMPT = `You are a conversation summarizer. Given a conversation between a user and an AI coding assistant, produce a concise summary that preserves:

1. Key decisions made and their rationale
2. Important technical details, file paths, and code patterns discovered
3. Current state of the work — what's done, what's pending
4. Any constraints, preferences, or requirements the user stated
5. Context needed for the conversation to continue productively

Format the summary as a structured document with clear sections. Be thorough but concise — aim for roughly 2000-4000 words. The summary will replace the original messages in the context window, so anything not captured here is lost.`;

export interface SummarizerConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface SummarizeResult {
  summary: string;
  usage: { promptTokens: number; completionTokens: number };
  durationMs: number;
}

interface ChatResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function summarizeExcerpt(
  excerpt: string,
  config: SummarizerConfig,
): Promise<SummarizeResult> {
  const t0 = Date.now();

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Here is the conversation to summarize:\n\n${excerpt}` },
      ],
      max_tokens: config.maxTokens ?? 8192,
      temperature: config.temperature ?? 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Summarizer API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as ChatResponse;
  const summary = data.choices?.[0]?.message?.content ?? '';
  if (!summary) throw new Error('Summarizer returned no content');

  const durationMs = Date.now() - t0;
  console.error(
    `${LOG} summary received in ${(durationMs / 1000).toFixed(1)}s ` +
    `(${data.usage?.prompt_tokens ?? '?'} prompt, ${data.usage?.completion_tokens ?? '?'} completion)`,
  );

  return {
    summary,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
    durationMs,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orcd/__tests__/summarizer-client.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/orcd/extensions/summarizer-client.ts src/orcd/__tests__/summarizer-client.test.ts
git commit -m "feat: add summarizer API client for rolling context window"
```

---

### Task 2: Summarizer Extension — Core State Machine

**Files:**
- Create: `src/orcd/extensions/summarizer.ts`
- Test: `src/orcd/__tests__/summarizer.test.ts`

The extension hooks into `context` events. It has three states:
- **idle**: checking if context exceeds threshold
- **summarizing**: background call in progress, pass messages through unchanged
- **ready**: summary available, splice it into messages on next `context` event

The extension builds a text excerpt from the oldest half of messages (extracting text from user/assistant content blocks), fires a background summarization call, and on the next `context` event replaces those messages with a single user message containing the summary.

- [ ] **Step 1: Write the failing test — idle state, under threshold**

```typescript
// src/orcd/__tests__/summarizer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { createSummarizerExtension, type SummarizerExtensionOptions } from '../extensions/summarizer';

// ─── helpers ──────────────────────────────────────────────────────────────────

function userMsg(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 0 } as AgentMessage;
}

function assistantMsg(text: string, outputTokens = 0): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input: 0, output: outputTokens, cacheRead: 0, cacheWrite: 0, totalTokens: outputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test',
    timestamp: 0,
  } as AgentMessage;
}

// NOTE: This is a minimal mock. The implementer should reference the fuller mock in
// src/orcd/__tests__/rolling-window.test.ts (makeMockRuntime) and include additional
// methods (getMessages, getSystemPrompt, etc.) if the extension API requires them.
function makeMockRuntime() {
  let contextHandler: ((event: { type: string; messages: AgentMessage[] }) => { messages: AgentMessage[] }) | undefined;
  const mockRuntime = {
    on: vi.fn((event: string, handler: (event: { type: string; messages: AgentMessage[] }) => { messages: AgentMessage[] }) => {
      if (event === 'context') contextHandler = handler;
    }),
    getMessages: vi.fn().mockReturnValue([]),
    getSystemPrompt: vi.fn().mockReturnValue(''),
    onContextWindowUpdate: vi.fn(),
  } as unknown as ExtensionAPI;
  return { mockRuntime, getContextHandler: () => contextHandler! };
}

const BASE_OPTS: SummarizerExtensionOptions = {
  summarizeThreshold: 0.5, // trigger at 50% of budget
  messageBudgetTokens: 1000, // small for testing
  summarizerConfig: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test',
    model: 'deepseek/deepseek-chat-v3-0324',
  },
};

// ─── tests ────────────────────────────────────────────────────────────────────

describe('createSummarizerExtension', () => {
  let summarizeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    summarizeMock = vi.fn().mockResolvedValue({
      summary: '# Summary\nKey decisions were made.',
      usage: { promptTokens: 500, completionTokens: 100 },
      durationMs: 1000,
    });
  });

  it('passes messages through unchanged when under threshold', () => {
    const { mockRuntime, getContextHandler } = makeMockRuntime();
    const factory = createSummarizerExtension(BASE_OPTS, summarizeMock);
    factory(mockRuntime);

    // ~14 tokens each msg, 2 msgs = ~28 tokens, well under 500 (50% of 1000)
    const msgs = [userMsg('hello'), assistantMsg('hi there')];
    const result = getContextHandler()({ type: 'context', messages: msgs });

    expect(result.messages).toEqual(msgs);
    expect(summarizeMock).not.toHaveBeenCalled();
  });

  it('triggers background summarization when over threshold', async () => {
    const { mockRuntime, getContextHandler } = makeMockRuntime();
    const factory = createSummarizerExtension(BASE_OPTS, summarizeMock);
    factory(mockRuntime);

    // Each msg ~200 tokens, 6 msgs = ~1200 tokens, over 500 threshold (50% of 1000)
    const bigText = 'a'.repeat(700);
    const msgs = [
      userMsg(bigText), assistantMsg(bigText),
      userMsg(bigText), assistantMsg(bigText),
      userMsg(bigText), assistantMsg(bigText),
    ];

    // First call: triggers background summarization, returns messages unchanged
    const result = getContextHandler()({ type: 'context', messages: msgs });
    expect(result.messages).toEqual(msgs);

    // Wait for background call to complete
    // Poll until mock is called (vi.waitFor may not exist in all vitest versions)
    await new Promise<void>((resolve) => {
      const check = () => { if (summarizeMock.mock.calls.length > 0) resolve(); else setTimeout(check, 10); };
      check();
    });
    expect(summarizeMock).toHaveBeenCalledOnce();
  });

  it('splices summary into messages after background call completes', async () => {
    const { mockRuntime, getContextHandler } = makeMockRuntime();
    const factory = createSummarizerExtension(BASE_OPTS, summarizeMock);
    factory(mockRuntime);

    const bigText = 'a'.repeat(700);
    const msgs = [
      userMsg(bigText), assistantMsg(bigText),
      userMsg(bigText), assistantMsg(bigText),
      userMsg('recent question'), assistantMsg('recent answer'),
    ];

    // First call: triggers summarization
    getContextHandler()({ type: 'context', messages: msgs });
    // Poll until mock is called (vi.waitFor may not exist in all vitest versions)
    await new Promise<void>((resolve) => {
      const check = () => { if (summarizeMock.mock.calls.length > 0) resolve(); else setTimeout(check, 10); };
      check();
    });
    expect(summarizeMock).toHaveBeenCalledOnce();

    // Second call: summary is ready, should splice
    const result2 = getContextHandler()({ type: 'context', messages: msgs });
    const resultMsgs = result2.messages;

    // First message should be the summary (injected as user message)
    expect(resultMsgs.length).toBeLessThan(msgs.length);
    const firstContent = (resultMsgs[0] as { role: string; content: string }).content;
    expect(firstContent).toContain('Summary');
    expect(firstContent).toContain('Key decisions');

    // Recent messages should be preserved
    const lastUser = resultMsgs[resultMsgs.length - 2] as { content: string };
    expect(lastUser.content).toBe('recent question');
  });

  it('does nothing when threshold is 0 (disabled)', () => {
    const { mockRuntime, getContextHandler } = makeMockRuntime();
    const factory = createSummarizerExtension({ ...BASE_OPTS, summarizeThreshold: 0 }, summarizeMock);
    factory(mockRuntime);

    const bigText = 'a'.repeat(700);
    const msgs = [
      userMsg(bigText), assistantMsg(bigText),
      userMsg(bigText), assistantMsg(bigText),
    ];

    const result = getContextHandler()({ type: 'context', messages: msgs });
    expect(result.messages).toEqual(msgs);
    expect(summarizeMock).not.toHaveBeenCalled();
  });

  it('does not trigger a second summarization while one is in-flight', () => {
    const { mockRuntime, getContextHandler } = makeMockRuntime();
    // Never resolves — simulates slow API
    summarizeMock = vi.fn().mockReturnValue(new Promise(() => {}));
    const factory = createSummarizerExtension(BASE_OPTS, summarizeMock);
    factory(mockRuntime);

    const bigText = 'a'.repeat(700);
    const msgs = [
      userMsg(bigText), assistantMsg(bigText),
      userMsg(bigText), assistantMsg(bigText),
    ];

    getContextHandler()({ type: 'context', messages: msgs });
    getContextHandler()({ type: 'context', messages: msgs });
    getContextHandler()({ type: 'context', messages: msgs });

    expect(summarizeMock).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orcd/__tests__/summarizer.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write the implementation**

```typescript
// src/orcd/extensions/summarizer.ts
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import type { ExtensionAPI, ContextEvent, ContextEventResult } from '@oh-my-pi/pi-coding-agent';
import type { Message } from '@oh-my-pi/pi-ai';
import { estimateMessageTokens } from '../context/token-estimator';
import { summarizeExcerpt, type SummarizerConfig, type SummarizeResult } from './summarizer-client';
import type { ExtensionFactory } from './rolling-window';

const LOG = '[summarizer-ext]';
const MAX_MSG_CHARS = 3000;

export interface SummarizerExtensionOptions {
  /** Fraction of messageBudgetTokens at which to trigger summarization. 0 = disabled. */
  summarizeThreshold: number;
  /** Total message budget in tokens (contextWindow - system prompt overhead). */
  messageBudgetTokens: number;
  /** OpenRouter config for the summarizer model. */
  summarizerConfig: SummarizerConfig;
  /** Callback when summarization completes. */
  onSummarized?: (coveredCount: number, summaryTokens: number) => void;
}

type State = 'idle' | 'summarizing' | 'ready';

/**
 * Extract readable text from a pi-ai Message, truncated.
 */
function extractText(msg: AgentMessage): string | null {
  const m = msg as Message;
  if (m.role === 'user' || m.role === 'developer') {
    const raw = typeof m.content === 'string'
      ? m.content
      : (m.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('\n');
    return raw.slice(0, MAX_MSG_CHARS);
  }
  if (m.role === 'assistant') {
    const blocks = m.content as Array<{ type: string; text?: string }>;
    const raw = blocks
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('\n');
    return raw.slice(0, MAX_MSG_CHARS);
  }
  return null;
}

/**
 * Build a conversation excerpt from the oldest `count` messages.
 */
function buildExcerpt(msgs: AgentMessage[], count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const txt = extractText(msgs[i]);
    if (txt) {
      const m = msgs[i] as Message;
      lines.push(`[${m.role}]: ${txt}`);
    }
  }
  return lines.join('\n\n');
}

/**
 * Create a pi extension that replaces dumb eviction with background summarization.
 *
 * On each `context` event:
 * - idle + under threshold → pass through
 * - idle + over threshold → fire background summarize, pass through
 * - summarizing → pass through (agent keeps working)
 * - ready → splice summary into messages, return to idle
 *
 * The `_summarizeFn` parameter exists for test injection. Production code omits it.
 */
export function createSummarizerExtension(
  opts: SummarizerExtensionOptions,
  _summarizeFn?: (excerpt: string, config: SummarizerConfig) => Promise<SummarizeResult>,
): ExtensionFactory {
  const threshold = opts.summarizeThreshold;
  const triggerTokens = opts.messageBudgetTokens * threshold;
  const callSummarize = _summarizeFn ?? summarizeExcerpt;

  let state: State = 'idle';
  let pendingSummary: string | null = null;
  let pendingCoveredCount = 0;

  return (api: ExtensionAPI): void => {
    if (threshold <= 0) {
      // Disabled — register a no-op handler so the extension signature is satisfied
      api.on('context', (event: ContextEvent): ContextEventResult => {
        return { messages: event.messages };
      });
      return;
    }

    api.on('context', (event: ContextEvent): ContextEventResult => {
      const msgs = event.messages as AgentMessage[];

      // ── ready: splice summary ────────────────────────────────────────────
      if (state === 'ready' && pendingSummary) {
        const summary = pendingSummary;
        const covered = pendingCoveredCount;
        pendingSummary = null;
        pendingCoveredCount = 0;
        state = 'idle';

        // Keep messages after the covered range
        const kept = msgs.slice(covered);

        // Inject summary as a user message at the front
        const summaryMsg: AgentMessage = {
          role: 'user',
          content: `[Context Summary — the following summarizes the earlier part of this conversation]\n\n${summary}`,
          timestamp: Date.now(),
        } as AgentMessage;

        const result = [summaryMsg, ...kept];
        const summaryTokens = Math.ceil(summary.length / 3.5);
        console.error(`${LOG} spliced summary (${summaryTokens} tokens) replacing ${covered} messages, ${kept.length} kept`);
        opts.onSummarized?.(covered, summaryTokens);

        return { messages: result };
      }

      // ── idle: check threshold ────────────────────────────────────────────
      if (state === 'idle') {
        const total = msgs.reduce((sum, m) => sum + estimateMessageTokens(m as Message), 0);

        if (total > triggerTokens) {
          state = 'summarizing';
          const coverCount = Math.floor(msgs.length / 2);

          console.error(`${LOG} threshold exceeded (${total} > ${triggerTokens}), summarizing oldest ${coverCount} messages`);

          const excerpt = buildExcerpt(msgs, coverCount);

          // Fire-and-forget: background summarization
          callSummarize(excerpt, opts.summarizerConfig)
            .then((result) => {
              pendingSummary = result.summary;
              pendingCoveredCount = coverCount;
              state = 'ready';
              console.error(`${LOG} summary ready (${result.summary.length} chars, ${result.durationMs}ms)`);
            })
            .catch((err) => {
              console.error(`${LOG} summarization failed, returning to idle:`, err);
              state = 'idle';
            });
        }
      }

      // ── idle or summarizing: pass through unchanged ──────────────────────
      return { messages: msgs };
    });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/orcd/__tests__/summarizer.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/orcd/extensions/summarizer.ts src/orcd/__tests__/summarizer.test.ts
git commit -m "feat: add summarizer extension with background summarization state machine"
```

---

### Task 3: Add `summarizeThreshold` to Card and Protocol

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/orcd-protocol.ts`
- Modify: `src/orcd/types.ts`
- Modify: `src/server/models/Card.ts`

This task adds the per-card `summarizeThreshold` field through the full stack: DB column, Card model, orcd protocol, and default constant.

- [ ] **Step 1: Add the default constant**

In `src/shared/constants.ts`, add at the end:

```typescript
/** Default summarize threshold as fraction of context window (0 = disabled). */
export const DEFAULT_SUMMARIZE_THRESHOLD = 0;
```

- [ ] **Step 2: Add to orcd protocol**

In `src/shared/orcd-protocol.ts`, add `summarizeThreshold` to `CreateAction`:

```typescript
export interface CreateAction {
  action: 'create';
  prompt: string;
  cwd: string;
  provider: string;
  model: string;
  effort?: string;
  sessionId?: string;
  env?: Record<string, string>;
  contextWindow?: number;
  summarizeThreshold?: number;  // ← add this line
}
```

- [ ] **Step 3: Add to PiSessionOptions**

In `src/orcd/types.ts`, add `summarizeThreshold` to `PiSessionOptions`:

```typescript
export interface PiSessionOptions {
  cwd: string;
  model: string;
  provider: string;
  providerConfig: import('./config').ProviderConfig;
  openrouterConfig?: import('./config').ProviderConfig;
  bufferSize?: number;
  sessionId?: string;
  contextWindow?: number;
  effort?: string;
  project?: string;
  summarizeThreshold?: number;  // ← add this line
}
```

- [ ] **Step 4: Add DB column and Card model field**

Add the column to the database:

```bash
sqlite3 data/orchestrel.db "ALTER TABLE cards ADD COLUMN summarize_threshold REAL NOT NULL DEFAULT 0;"
```

In `src/server/models/Card.ts`, add after the `contextWindow` column:

```typescript
  @Column({ name: 'summarize_threshold', type: 'real', default: 0 })
  summarizeThreshold!: number;
```

- [ ] **Step 5: Add to ws-protocol.ts zod schemas**

In `src/shared/ws-protocol.ts`:

1. Add `summarizeThreshold` to `cardSchema`:
```typescript
  contextWindow: z.number(),
  summarizeThreshold: z.number(),
```

2. Add `summarizeThreshold` to `cardCreateSchema`:
```typescript
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional(),
  summarizeThreshold: z.number().min(0).max(1).optional(),
```

3. `cardUpdateSchema` inherits via `.merge(cardCreateSchema.partial())` so no change needed there.

- [ ] **Step 6: Commit**

```bash
git add src/shared/constants.ts src/shared/orcd-protocol.ts src/orcd/types.ts src/server/models/Card.ts src/shared/ws-protocol.ts
git commit -m "feat: add summarizeThreshold field to card, protocol, constants, and ws-protocol"
```

---

### Task 4: Wire Summarizer Extension into Pi Session

**Files:**
- Modify: `src/orcd/pi-session.ts`
- Modify: `src/server/controllers/card-sessions.ts`

This task connects the summarizer extension to the Pi session so it runs during agent work, and passes the threshold from the card through the orcd protocol.

- [ ] **Step 1: Wire summarizer into pi-session.ts**

In `src/orcd/pi-session.ts`, add the import at the top alongside the other extension imports:

```typescript
import { createSummarizerExtension } from './extensions/summarizer';
```

In the `run()` method, inside the extensions array construction (after `createCacheBreakpointExtension()`), add:

```typescript
      // Add summarizer extension if threshold is set and openrouter is available
      if (this.opts.summarizeThreshold && this.opts.summarizeThreshold > 0 && this.opts.openrouterConfig) {
        extensions.push(
          createSummarizerExtension({
            summarizeThreshold: this.opts.summarizeThreshold,
            messageBudgetTokens: messageBudget,
            summarizerConfig: {
              baseUrl: this.opts.openrouterConfig.baseUrl,
              apiKey: this.opts.openrouterConfig.apiKey,
              model: 'deepseek/deepseek-chat-v3-0324',
            },
            onSummarized: (coveredCount, summaryTokens) => {
              log(`summarized ${coveredCount} messages → ${summaryTokens} tokens`);
            },
          }),
        );
      }
```

- [ ] **Step 2: Pass summarizeThreshold from card to orcd create action**

In `src/server/controllers/card-sessions.ts`, in the `registerAutoStart` function, find where `client.create()` is called and add `summarizeThreshold`:

```typescript
      const sessionId = await client.create({
        prompt,
        cwd,
        provider: fullCard.provider,
        model: fullCard.model,
        sessionId: fullCard.sessionId ?? undefined,
        contextWindow: fullCard.contextWindow,
        summarizeThreshold: fullCard.summarizeThreshold,  // ← add this line
      });
```

- [ ] **Step 3: Pass summarizeThreshold through orcd socket server to PiSession**

Find where the orcd socket server creates `PiSession` instances and ensure `summarizeThreshold` from `CreateAction` is passed through to `PiSessionOptions`. Check `src/orcd/socket-server.ts`:

In the `handleCreate` or equivalent function that processes `CreateAction`, ensure the field is forwarded:

```typescript
  summarizeThreshold: action.summarizeThreshold,
```

- [ ] **Step 4: Verify the full chain works**

Run: `npx vitest run src/orcd/__tests__/summarizer.test.ts src/orcd/__tests__/summarizer-client.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/orcd/pi-session.ts src/server/controllers/card-sessions.ts src/orcd/socket-server.ts
git commit -m "feat: wire summarizer extension into pi session and card creation flow"
```

---

### Task 5: Interaction with Rolling Window Extension

**Files:**
- Modify: `src/orcd/pi-session.ts`

The summarizer and rolling-window extensions both modify messages on `context` events. They must be ordered correctly:

1. **Summarizer runs first** — it may splice a summary in, reducing token count
2. **Rolling window runs second** — if context is still over budget after summarization (e.g., summary hasn't returned yet), it evicts as a fallback

The Pi extension system processes `context` handlers in registration order.

- [ ] **Step 1: Verify extension ordering in pi-session.ts**

Ensure the `extensions` array in `pi-session.ts` `run()` has this order:

```typescript
      const extensions = [
        // Summarizer FIRST — may splice summary, reducing tokens
        ...(this.opts.summarizeThreshold && this.opts.summarizeThreshold > 0 && this.opts.openrouterConfig
          ? [createSummarizerExtension({
              summarizeThreshold: this.opts.summarizeThreshold,
              messageBudgetTokens: messageBudget,
              summarizerConfig: {
                baseUrl: this.opts.openrouterConfig.baseUrl,
                apiKey: this.opts.openrouterConfig.apiKey,
                model: 'deepseek/deepseek-chat-v3-0324',
              },
              onSummarized: (coveredCount, summaryTokens) => {
                log(`summarized ${coveredCount} messages → ${summaryTokens} tokens`);
              },
            })]
          : []),
        // Rolling window SECOND — fallback eviction if still over budget
        createRollingWindowExtension({
          messageBudgetTokens: messageBudget,
          onEviction: (evicted, remaining) => {
            log(`evicted ${evicted} messages, ${remaining} remaining`);
          },
        }),
        createCacheBreakpointExtension(),
        // NOTE: Also preserve the existing memory-upsert extension wiring:
        // ...(memoryEnabled ? [createMemoryUpsertExtension({ ... })] : []),
        // Do NOT remove it — this snippet only shows the ordering for summarizer + rolling-window.
      ];
```

- [ ] **Step 2: Write a test for the interaction**

Add to `src/orcd/__tests__/summarizer.test.ts`:

```typescript
  it('works as fallback when summarizer is in-flight — rolling window still evicts', () => {
    // This test verifies the summarizer passes messages through unchanged while
    // summarizing, allowing the rolling window (which runs after) to evict if needed.
    const { mockRuntime, getContextHandler } = makeMockRuntime();
    // Slow summarizer that never resolves
    const slowMock = vi.fn().mockReturnValue(new Promise(() => {}));
    const factory = createSummarizerExtension(BASE_OPTS, slowMock);
    factory(mockRuntime);

    const bigText = 'a'.repeat(700);
    const msgs = [
      userMsg(bigText), assistantMsg(bigText),
      userMsg(bigText), assistantMsg(bigText),
    ];

    // Triggers summarization but returns messages unchanged
    const result = getContextHandler()({ type: 'context', messages: msgs });
    // Messages should be passed through — rolling window (not tested here) would handle eviction
    expect(result.messages).toEqual(msgs);
    expect(result.messages.length).toBe(msgs.length);
  });
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/orcd/__tests__/summarizer.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 4: Commit**

```bash
git add src/orcd/pi-session.ts src/orcd/__tests__/summarizer.test.ts
git commit -m "feat: order summarizer before rolling-window for graceful fallback"
```

---

### Task 6: Update OrcdClient to Pass summarizeThreshold

**Files:**
- Modify: `src/server/orcd-client.ts`

The OrcdClient is the web server's connection to orcd. Its `create()` method builds the `CreateAction`. We need to ensure `summarizeThreshold` is included.

- [ ] **Step 1: Check OrcdClient.create() signature**

Read `src/server/orcd-client.ts` and find the `create()` method. Add `summarizeThreshold` to its options type and forward it in the action:

```typescript
  async create(opts: {
    prompt: string;
    cwd: string;
    provider: string;
    model: string;
    sessionId?: string;
    contextWindow?: number;
    summarizeThreshold?: number;  // ← add
  }): Promise<string> {
    // ... existing code ...
    const action: CreateAction = {
      action: 'create',
      prompt: opts.prompt,
      cwd: opts.cwd,
      provider: opts.provider,
      model: opts.model,
      sessionId: opts.sessionId,
      contextWindow: opts.contextWindow,
      summarizeThreshold: opts.summarizeThreshold,  // ← add
    };
    // ... rest of method ...
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/server/orcd-client.ts
git commit -m "feat: pass summarizeThreshold through OrcdClient.create()"
```

---

### Task 7: Smoke Test — End-to-End Verification

**Files:** No new files — this is a manual verification task.

- [ ] **Step 1: Run the full test suite**

```bash
npx vitest run
```

Expected: All tests pass, including the new summarizer tests.

- [ ] **Step 2: Verify the DB migration**

```bash
sqlite3 data/orchestrel.db ".schema cards" | grep summarize
```

Expected: `summarize_threshold REAL NOT NULL DEFAULT 0`

- [ ] **Step 3: Test with a card**

1. Set a card's `summarize_threshold` to 0.5 in the DB:
   ```bash
   sqlite3 data/orchestrel.db "UPDATE cards SET summarize_threshold = 0.5 WHERE id = <card-id>;"
   ```
2. Run the card and watch orcd logs for `[summarizer-ext]` messages
3. Verify the agent continues working while summarization happens in the background
4. Verify the summary gets spliced on the next turn

- [ ] **Step 4: Test with threshold = 0 (disabled)**

1. Confirm cards with `summarize_threshold = 0` never trigger summarization
2. The rolling window should still evict as before

- [ ] **Step 5: Commit any fixes**

```bash
git commit -m "fix: address issues found during smoke testing"
```

---

## Notes for Implementer

- **Test runner:** Use `npx vitest run`, NOT `bun test`. Vitest has `vi.stubGlobal` which bun lacks.
- **Branch:** All work happens on `pi-framework-evaluation-for-orchestrel`. The pi worktree may need recreation — check if it exists at `/home/ryan/Code/orchestrel/.worktrees/pi-framework-evaluation-for-orchestrel/`.
- **OpenRouter config:** The summarizer reads from the `openrouter` provider in `~/.orc/config.yaml` (or `~/.orc/config-pi.yaml` for the pi test instance). The API key and base URL are already configured.
- **DeepSeek V3 model ID:** `deepseek/deepseek-chat-v3-0324` — this was benchmarked and confirmed working for 34k-100k token summarization tasks.
- **The existing `rolling-window.ts` and `context/manager.ts` are NOT modified.** The summarizer is additive — it runs before the rolling window. If the summarizer is disabled or hasn't fired yet, the rolling window evicts as before.
- **DB column:** Add via `sqlite3` CLI, NOT via a migration framework. Per CLAUDE.md: "Schema additions (ALTER TABLE ADD COLUMN) via sqlite3 CLI are safe anytime."
