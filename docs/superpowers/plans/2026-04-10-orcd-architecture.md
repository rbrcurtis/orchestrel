# orcd Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken meridian-based session backend with a standalone orcd daemon that manages Claude Code subprocesses via the Agent SDK, yielding proper session resume, clean JSONL, and multi-provider support via CCR.

**Architecture:** orcd is a standalone Node/TS daemon that owns CC subprocess lifecycles. It exposes a Unix socket (`~/.orc/orcd.sock`) with newline-delimited JSON protocol. Orc's web server connects to orcd as a client, bridging browser Socket.IO connections to orcd sessions. The frontend stays mostly unchanged — its SDK message types already align with Agent SDK output. KPP gets independent effort/thinking support.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, `yaml` (npm), Node `net` module (Unix sockets), `vitest`

**Parallelism:** Tasks 1-3 can run in parallel. Task 12 (KPP) is fully independent. Tasks 4-6 build sequentially on each other. Tasks 7-11 integrate orcd into the existing Orc codebase.

---

## File Map

### New files (orcd daemon)

| File                                     | Responsibility                                             |
| ---------------------------------------- | ---------------------------------------------------------- |
| `src/orcd/index.ts`                      | Entry point: load config, start socket server              |
| `src/orcd/config.ts`                     | YAML config parser with env var interpolation              |
| `src/orcd/socket-server.ts`              | Unix socket listener, connection handling, message routing |
| `src/orcd/session.ts`                    | Wraps Agent SDK `query()`, manages one CC session          |
| `src/orcd/session-store.ts`              | In-memory map of active sessions                           |
| `src/orcd/ring-buffer.ts`                | Per-session circular event buffer for reconnection         |
| `src/orcd/types.ts`                      | Internal orcd types (non-protocol)                         |
| `src/orcd/__tests__/ring-buffer.test.ts` | Ring buffer unit tests                                     |
| `src/orcd/__tests__/config.test.ts`      | Config loader unit tests                                   |

### New files (shared)

| File                          | Responsibility                                       |
| ----------------------------- | ---------------------------------------------------- |
| `src/shared/orcd-protocol.ts` | Message types for client ↔ orcd Unix socket protocol |

### New files (orc bridge)

| File                        | Responsibility                                     |
| --------------------------- | -------------------------------------------------- |
| `src/server/orcd-client.ts` | Unix socket client, connect/send/receive/reconnect |

### Modified files

| File                                 | Change                                                               |
| ------------------------------------ | -------------------------------------------------------------------- |
| `src/server/init-state.ts`           | Replace SessionManager with OrcdClient                               |
| `src/server/ws/handlers/agents.ts`   | Use OrcdClient instead of SessionManager                             |
| `src/server/ws/handlers/sessions.ts` | Use `getSessionMessages()` from Agent SDK                            |
| `src/server/controllers/oc.ts`       | Auto-start sends "create" to orcd client                             |
| `src/server/ws/server.ts`            | Connect OrcdClient in dev mode                                       |
| `src/server/init.ts`                 | Connect OrcdClient in production                                     |
| `package.json`                       | Add `@anthropic-ai/claude-agent-sdk`, `yaml` deps; add `orcd` script |

### Deleted files

| File                                      | Reason                                 |
| ----------------------------------------- | -------------------------------------- |
| `src/server/sessions/consumer.ts`         | Replaced by orcd session wrapper       |
| `src/server/sessions/manager.ts`          | Replaced by OrcdClient                 |
| `src/server/sessions/meridian-client.ts`  | Replaced by Agent SDK in orcd          |
| `src/server/sessions/event-translator.ts` | Agent SDK emits proper types directly  |
| `src/server/sessions/sse-parser.ts`       | No more raw SSE parsing                |
| `src/server/sessions/jsonl-reader.ts`     | Replaced by SDK `getSessionMessages()` |

### KPP files (separate repo: `/home/ryan/Code/kiro-pool-proxy`)

| File                            | Change                                  |
| ------------------------------- | --------------------------------------- |
| `src/proxy/types.ts`            | Add thinking fields to AnthropicRequest |
| `src/proxy/convert-request.ts`  | Map thinking config to CW format        |
| `tests/convert-request.test.ts` | Add thinking conversion tests           |

---

### Task 1: Shared Protocol Types & Project Scaffolding

**Files:**

- Create: `src/shared/orcd-protocol.ts`
- Modify: `package.json`

This task defines the contract between orcd and its clients. Every other task depends on these types.

- [ ] **Step 1: Install dependencies**

```bash
cd /home/ryan/Code/orchestrel
pnpm add @anthropic-ai/claude-agent-sdk yaml
```

- [ ] **Step 2: Add orcd script to package.json**

Add to the `"scripts"` section of `package.json`:

```json
"orcd": "tsx src/orcd/index.ts"
```

- [ ] **Step 3: Create the protocol types**

```typescript
// src/shared/orcd-protocol.ts

// ── Client → orcd ────────────────────────────────────────────────────────────

export interface CreateAction {
  action: 'create';
  prompt: string;
  cwd: string;
  provider: string;
  model: string;
  effort?: string; // 'high' | 'medium' | 'low' | 'disabled'
  sessionId?: string; // Resume existing session
  env?: Record<string, string>; // ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY
}

export interface MessageAction {
  action: 'message';
  sessionId: string;
  prompt: string;
}

export interface SetEffortAction {
  action: 'set_effort';
  sessionId: string;
  effort: string;
}

export interface SubscribeAction {
  action: 'subscribe';
  sessionId: string;
  afterEventIndex?: number;
}

export interface UnsubscribeAction {
  action: 'unsubscribe';
  sessionId: string;
}

export interface ListAction {
  action: 'list';
}

export interface CancelAction {
  action: 'cancel';
  sessionId: string;
}

export type OrcdAction =
  CreateAction | MessageAction | SetEffortAction | SubscribeAction | UnsubscribeAction | ListAction | CancelAction;

// ── orcd → Client ────────────────────────────────────────────────────────────

export interface SessionCreatedMessage {
  type: 'session_created';
  sessionId: string;
}

export interface StreamEventMessage {
  type: 'stream_event';
  sessionId: string;
  eventIndex: number;
  event: unknown; // SDKMessage from Agent SDK
}

export interface SessionResultMessage {
  type: 'result';
  sessionId: string;
  eventIndex: number;
  result: unknown; // SDKResultMessage from Agent SDK
}

export interface SessionErrorMessage {
  type: 'error';
  sessionId: string;
  error: string;
}

export interface SessionListMessage {
  type: 'session_list';
  sessions: Array<{
    id: string;
    state: 'running' | 'completed' | 'errored' | 'stopped';
    cwd: string;
  }>;
}

export type OrcdMessage =
  SessionCreatedMessage | StreamEventMessage | SessionResultMessage | SessionErrorMessage | SessionListMessage;
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/orcd-protocol.ts package.json pnpm-lock.yaml
git commit -m "feat: add orcd protocol types and Agent SDK dependency"
```

---

### Task 2: Ring Buffer

**Files:**

- Create: `src/orcd/ring-buffer.ts`
- Create: `src/orcd/__tests__/ring-buffer.test.ts`

Pure data structure — no dependencies. Stores the most recent N events per session for replay on client reconnection.

- [ ] **Step 1: Write failing tests**

```typescript
// src/orcd/__tests__/ring-buffer.test.ts
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../ring-buffer';

describe('RingBuffer', () => {
  it('stores and retrieves events in order', () => {
    const buf = new RingBuffer<string>(5);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.since(-1)).toEqual([
      { index: 0, item: 'a' },
      { index: 1, item: 'b' },
      { index: 2, item: 'c' },
    ]);
  });

  it('wraps around when capacity exceeded', () => {
    const buf = new RingBuffer<string>(3);
    buf.push('a'); // 0
    buf.push('b'); // 1
    buf.push('c'); // 2
    buf.push('d'); // 3  — evicts 'a'
    buf.push('e'); // 4  — evicts 'b'
    const items = buf.since(-1);
    expect(items).toEqual([
      { index: 2, item: 'c' },
      { index: 3, item: 'd' },
      { index: 4, item: 'e' },
    ]);
  });

  it('returns events after a given index', () => {
    const buf = new RingBuffer<string>(10);
    buf.push('a'); // 0
    buf.push('b'); // 1
    buf.push('c'); // 2
    buf.push('d'); // 3
    expect(buf.since(1)).toEqual([
      { index: 2, item: 'c' },
      { index: 3, item: 'd' },
    ]);
  });

  it('returns empty array when afterIndex >= lastIndex', () => {
    const buf = new RingBuffer<string>(5);
    buf.push('a'); // 0
    buf.push('b'); // 1
    expect(buf.since(1)).toEqual([]);
    expect(buf.since(5)).toEqual([]);
  });

  it('returns lastIndex correctly', () => {
    const buf = new RingBuffer<string>(5);
    expect(buf.lastIndex).toBe(-1);
    buf.push('a');
    expect(buf.lastIndex).toBe(0);
    buf.push('b');
    expect(buf.lastIndex).toBe(1);
  });

  it('handles since() when requested index was already evicted', () => {
    const buf = new RingBuffer<string>(2);
    buf.push('a'); // 0
    buf.push('b'); // 1
    buf.push('c'); // 2 — evicts 'a'
    // Requesting after index 0, but 'a' (index 0) is gone.
    // Should return everything still in the buffer.
    const items = buf.since(0);
    expect(items).toEqual([
      { index: 1, item: 'b' },
      { index: 2, item: 'c' },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/ryan/Code/orchestrel
npx vitest run src/orcd/__tests__/ring-buffer.test.ts
```

Expected: FAIL — module `../ring-buffer` not found.

- [ ] **Step 3: Implement ring buffer**

```typescript
// src/orcd/ring-buffer.ts

export interface IndexedItem<T> {
  index: number;
  item: T;
}

/**
 * Fixed-capacity circular buffer with monotonic indexing.
 * Oldest items are evicted when capacity is exceeded.
 */
export class RingBuffer<T> {
  private items: Array<T | undefined>;
  private head = 0; // write position in items[]
  private count = 0; // total items currently stored
  private nextIndex = 0; // monotonic event index

  constructor(private capacity: number) {
    this.items = new Array(capacity);
  }

  push(item: T): number {
    const idx = this.nextIndex++;
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return idx;
  }

  get lastIndex(): number {
    return this.nextIndex - 1;
  }

  /**
   * Return all items with index > afterIndex.
   * If afterIndex is -1, returns everything in the buffer.
   */
  since(afterIndex: number): IndexedItem<T>[] {
    if (this.count === 0) return [];

    const oldestIndex = this.nextIndex - this.count;
    const startIndex = Math.max(afterIndex + 1, oldestIndex);

    if (startIndex >= this.nextIndex) return [];

    const result: IndexedItem<T>[] = [];
    for (let idx = startIndex; idx < this.nextIndex; idx++) {
      const pos = (((this.head - this.count + (idx - oldestIndex)) % this.capacity) + this.capacity) % this.capacity;
      result.push({ index: idx, item: this.items[pos]! });
    }
    return result;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/orcd/__tests__/ring-buffer.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orcd/ring-buffer.ts src/orcd/__tests__/ring-buffer.test.ts
git commit -m "feat(orcd): add ring buffer for event replay"
```

---

### Task 3: YAML Config Loader

**Files:**

- Create: `src/orcd/config.ts`
- Create: `src/orcd/__tests__/config.test.ts`

Parses `~/.orc/config.yaml`. Resolves `${VAR}` env var interpolation. Validates provider structure.

- [ ] **Step 1: Write failing tests**

```typescript
// src/orcd/__tests__/config.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseConfig, resolveEnvVars, type OrcdConfig } from '../config';

describe('resolveEnvVars', () => {
  it('replaces ${VAR} with env value', () => {
    expect(resolveEnvVars('key=${MY_KEY}', { MY_KEY: 'secret' })).toBe('key=secret');
  });

  it('leaves unset vars as empty string', () => {
    expect(resolveEnvVars('${MISSING}', {})).toBe('');
  });

  it('handles multiple vars in one string', () => {
    expect(resolveEnvVars('${A}:${B}', { A: 'x', B: 'y' })).toBe('x:y');
  });

  it('returns plain strings unchanged', () => {
    expect(resolveEnvVars('no-vars-here', {})).toBe('no-vars-here');
  });
});

describe('parseConfig', () => {
  it('parses minimal config', () => {
    const yaml = `
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
defaultCwd: ~/projects
defaultEffort: high

providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: test-key
    models:
      - claude-sonnet-4-6
`;
    const cfg = parseConfig(yaml, {});
    expect(cfg.defaultProvider).toBe('anthropic');
    expect(cfg.providers.anthropic.baseUrl).toBe('https://api.anthropic.com');
    expect(cfg.providers.anthropic.models).toContain('claude-sonnet-4-6');
  });

  it('resolves env vars in apiKey', () => {
    const yaml = `
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: \${ANTHROPIC_API_KEY}
    models:
      - claude-sonnet-4-6
`;
    const cfg = parseConfig(yaml, { ANTHROPIC_API_KEY: 'sk-live-123' });
    expect(cfg.providers.anthropic.apiKey).toBe('sk-live-123');
  });

  it('uses provider-level effort default', () => {
    const yaml = `
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
defaultEffort: high
providers:
  local:
    baseUrl: http://localhost:11434
    apiKey: dummy
    effort: disabled
    models:
      - llama
`;
    const cfg = parseConfig(yaml, {});
    expect(cfg.providers.local.effort).toBe('disabled');
  });

  it('throws on missing providers', () => {
    const yaml = `
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
`;
    expect(() => parseConfig(yaml, {})).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/orcd/__tests__/config.test.ts
```

Expected: FAIL — module `../config` not found.

- [ ] **Step 3: Implement config loader**

```typescript
// src/orcd/config.ts
import { parse as parseYaml } from 'yaml';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  effort?: string;
  models: string[];
}

export interface OrcdConfig {
  socket: string;
  defaultProvider: string;
  defaultModel: string;
  defaultCwd?: string;
  defaultEffort?: string;
  providers: Record<string, ProviderConfig>;
}

/**
 * Replace ${VAR} patterns with values from env.
 * Unset vars become empty string.
 */
export function resolveEnvVars(str: string, env: Record<string, string | undefined>): string {
  return str.replace(/\$\{(\w+)\}/g, (_, name) => env[name] ?? '');
}

/**
 * Parse YAML config string into validated OrcdConfig.
 * Resolves env var interpolation in all string values.
 */
export function parseConfig(yamlStr: string, env: Record<string, string | undefined>): OrcdConfig {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;

  if (!raw.providers || typeof raw.providers !== 'object') {
    throw new Error('config: "providers" section is required');
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, p] of Object.entries(raw.providers as Record<string, Record<string, unknown>>)) {
    if (!p.baseUrl || !p.models) {
      throw new Error(`config: provider "${name}" requires baseUrl and models`);
    }
    providers[name] = {
      baseUrl: resolveEnvVars(String(p.baseUrl), env),
      apiKey: resolveEnvVars(String(p.apiKey ?? 'dummy'), env),
      effort: p.effort != null ? String(p.effort) : undefined,
      models: (p.models as string[]).map(String),
    };
  }

  return {
    socket: String(raw.socket ?? '~/.orc/orcd.sock'),
    defaultProvider: String(raw.defaultProvider ?? 'anthropic'),
    defaultModel: String(raw.defaultModel ?? 'claude-sonnet-4-6'),
    defaultCwd: raw.defaultCwd != null ? String(raw.defaultCwd) : undefined,
    defaultEffort: raw.defaultEffort != null ? String(raw.defaultEffort) : undefined,
    providers,
  };
}

/**
 * Load config from ~/.orc/config.yaml.
 */
export async function loadConfig(): Promise<OrcdConfig> {
  const { readFile } = await import('fs/promises');
  const { homedir } = await import('os');
  const path = `${homedir()}/.orc/config.yaml`;
  const content = await readFile(path, 'utf-8');
  return parseConfig(content, process.env as Record<string, string | undefined>);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/orcd/__tests__/config.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orcd/config.ts src/orcd/__tests__/config.test.ts
git commit -m "feat(orcd): add YAML config loader with env var interpolation"
```

---

### Task 4: Session Wrapper (Agent SDK)

**Files:**

- Create: `src/orcd/session.ts`
- Create: `src/orcd/types.ts`

Wraps the Agent SDK's `query()` function. Each `OrcdSession` manages one CC subprocess: spawning, streaming events, resume, cancel, and effort changes.

- [ ] **Step 1: Create internal types**

```typescript
// src/orcd/types.ts

export type SessionState = 'running' | 'completed' | 'errored' | 'stopped';

export interface SessionInfo {
  id: string;
  state: SessionState;
  cwd: string;
  model: string;
  provider: string;
}
```

- [ ] **Step 2: Implement session wrapper**

```typescript
// src/orcd/session.ts
import { randomUUID } from 'crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { RingBuffer } from './ring-buffer';
import type { SessionState } from './types';
import type { StreamEventMessage, SessionErrorMessage, SessionResultMessage } from '../shared/orcd-protocol';

export type SessionEventCallback = (msg: StreamEventMessage | SessionResultMessage | SessionErrorMessage) => void;

/**
 * Effort level → Agent SDK thinking config.
 */
function effortToThinking(effort: string | undefined): Record<string, unknown> {
  switch (effort) {
    case 'disabled':
      return { thinking: { type: 'disabled' } };
    case 'low':
      return { effort: 'low' as const };
    case 'medium':
      return { effort: 'medium' as const };
    case 'max':
      return { effort: 'max' as const };
    case 'high':
    default:
      return { effort: 'high' as const };
  }
}

/**
 * Effort level → thinking token budget for runtime changes.
 */
function effortToTokenBudget(effort: string): number | null {
  switch (effort) {
    case 'disabled':
      return 0;
    case 'low':
      return 2000;
    case 'medium':
      return 10000;
    case 'high':
      return null; // unlimited
    case 'max':
      return null;
    default:
      return null;
  }
}

export class OrcdSession {
  readonly id: string;
  state: SessionState = 'running';
  readonly cwd: string;
  readonly model: string;
  readonly provider: string;
  readonly buffer: RingBuffer<unknown>;

  private activeQuery: Query | null = null;
  private subscribers = new Set<SessionEventCallback>();

  constructor(opts: {
    cwd: string;
    model: string;
    provider: string;
    bufferSize?: number;
    sessionId?: string; // For resume — use existing CC session UUID
  }) {
    this.id = opts.sessionId ?? randomUUID();
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.provider = opts.provider;
    this.buffer = new RingBuffer(opts.bufferSize ?? 1000);
  }

  subscribe(cb: SessionEventCallback): void {
    this.subscribers.add(cb);
  }

  unsubscribe(cb: SessionEventCallback): void {
    this.subscribers.delete(cb);
  }

  /**
   * Replay buffered events to a subscriber (for reconnection).
   */
  replay(afterEventIndex: number | undefined, cb: SessionEventCallback): void {
    const events = this.buffer.since(afterEventIndex ?? -1);
    for (const { index, item } of events) {
      cb({
        type: 'stream_event',
        sessionId: this.id,
        eventIndex: index,
        event: item,
      });
    }
  }

  /**
   * Start or resume a session.
   * Consumes the Agent SDK async iterator and broadcasts events.
   */
  async run(opts: { prompt: string; resume?: boolean; env?: Record<string, string>; effort?: string }): Promise<void> {
    const log = (msg: string) => console.log(`[orcd:${this.id.slice(0, 8)}] ${msg}`);

    const thinkingOpts = effortToThinking(opts.effort);

    const q = sdkQuery({
      prompt: opts.prompt,
      options: {
        ...(opts.resume ? { resume: this.id } : { sessionId: this.id }),
        cwd: this.cwd,
        model: this.model,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['user', 'project'],
        includePartialMessages: true,
        env: opts.env,
        ...thinkingOpts,
      },
    });

    this.activeQuery = q;
    log(`started (resume=${!!opts.resume}, model=${this.model})`);

    try {
      for await (const event of q) {
        if (this.state === 'stopped') break;

        const sdkEvent = event as Record<string, unknown>;
        const eventIndex = this.buffer.push(sdkEvent);

        // Determine message type
        if (sdkEvent.type === 'result') {
          const msg: SessionResultMessage = {
            type: 'result',
            sessionId: this.id,
            eventIndex,
            result: sdkEvent,
          };
          for (const cb of this.subscribers) cb(msg);
        } else {
          const msg: StreamEventMessage = {
            type: 'stream_event',
            sessionId: this.id,
            eventIndex,
            event: sdkEvent,
          };
          for (const cb of this.subscribers) cb(msg);
        }
      }

      if (this.state !== 'stopped') {
        this.state = 'completed';
      }
      log(`completed (state=${this.state})`);
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('abort') || errStr.includes('AbortError')) {
        this.state = 'stopped';
        log(`stopped`);
      } else {
        this.state = 'errored';
        log(`error: ${errStr}`);
        const msg: SessionErrorMessage = {
          type: 'error',
          sessionId: this.id,
          error: errStr,
        };
        for (const cb of this.subscribers) cb(msg);
      }
    } finally {
      this.activeQuery = null;
    }
  }

  /**
   * Send a follow-up message (resume into existing session).
   */
  async sendMessage(prompt: string, env?: Record<string, string>, effort?: string): Promise<void> {
    this.state = 'running';
    await this.run({ prompt, resume: true, env, effort });
  }

  /**
   * Change thinking budget mid-session.
   */
  async setEffort(effort: string): Promise<void> {
    if (!this.activeQuery) return;
    const budget = effortToTokenBudget(effort);
    await this.activeQuery.setMaxThinkingTokens(budget);
    console.log(`[orcd:${this.id.slice(0, 8)}] effort → ${effort} (budget=${budget})`);
  }

  /**
   * Cancel the running session.
   */
  async cancel(): Promise<void> {
    this.state = 'stopped';
    if (this.activeQuery) {
      await this.activeQuery.interrupt();
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/orcd/session.ts src/orcd/types.ts
git commit -m "feat(orcd): add session wrapper around Agent SDK query()"
```

---

### Task 5: Socket Server & Session Store

**Files:**

- Create: `src/orcd/session-store.ts`
- Create: `src/orcd/socket-server.ts`

The socket server listens on a Unix socket. Each connected client sends newline-delimited JSON actions. The server routes actions to the session store and broadcasts events to subscribed clients.

- [ ] **Step 1: Implement session store**

```typescript
// src/orcd/session-store.ts
import { OrcdSession } from './session';
import type { SessionInfo } from './types';

/**
 * In-memory store of active sessions.
 */
export class SessionStore {
  private sessions = new Map<string, OrcdSession>();

  get(id: string): OrcdSession | undefined {
    return this.sessions.get(id);
  }

  add(session: OrcdSession): void {
    this.sessions.set(session.id, session);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      state: s.state,
      cwd: s.cwd,
      model: s.model,
      provider: s.provider,
    }));
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }
}
```

- [ ] **Step 2: Implement socket server**

```typescript
// src/orcd/socket-server.ts
import { createServer, type Server, type Socket } from 'net';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { OrcdSession, type SessionEventCallback } from './session';
import { SessionStore } from './session-store';
import type { OrcdAction, OrcdMessage } from '../shared/orcd-protocol';
import type { ProviderConfig } from './config';

interface ClientState {
  socket: Socket;
  subscriptions: Map<string, SessionEventCallback>;
}

export class OrcdServer {
  private server: Server | null = null;
  private clients = new Set<ClientState>();
  readonly store = new SessionStore();

  constructor(
    private socketPath: string,
    private providers: Record<string, ProviderConfig>,
    private defaults: { provider: string; model: string; effort?: string },
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Ensure socket directory exists
      const dir = dirname(this.socketPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // Remove stale socket file
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);

      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        console.log(`[orcd] listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  stop(): void {
    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.server?.close();
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    console.log('[orcd] stopped');
  }

  private handleConnection(socket: Socket): void {
    const client: ClientState = { socket, subscriptions: new Map() };
    this.clients.add(client);
    console.log('[orcd] client connected');

    let buf = '';
    socket.on('data', (data) => {
      buf += data.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const action = JSON.parse(line) as OrcdAction;
          this.handleAction(client, action);
        } catch (err) {
          this.send(client, { type: 'error', sessionId: '', error: `parse error: ${err}` });
        }
      }
    });

    socket.on('close', () => {
      // Clean up subscriptions
      for (const [sessionId, cb] of client.subscriptions) {
        this.store.get(sessionId)?.unsubscribe(cb);
      }
      this.clients.delete(client);
      console.log('[orcd] client disconnected');
    });

    socket.on('error', (err) => {
      console.error('[orcd] client error:', err.message);
    });
  }

  private send(client: ClientState, msg: OrcdMessage): void {
    if (client.socket.writable) {
      client.socket.write(JSON.stringify(msg) + '\n');
    }
  }

  private handleAction(client: ClientState, action: OrcdAction): void {
    switch (action.action) {
      case 'create':
        this.handleCreate(client, action);
        break;
      case 'message':
        this.handleMessage(client, action);
        break;
      case 'set_effort':
        this.handleSetEffort(action);
        break;
      case 'subscribe':
        this.handleSubscribe(client, action);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(client, action);
        break;
      case 'list':
        this.send(client, { type: 'session_list', sessions: this.store.list() });
        break;
      case 'cancel':
        this.handleCancel(action);
        break;
    }
  }

  private handleCreate(client: ClientState, action: OrcdAction & { action: 'create' }): void {
    const providerCfg = this.providers[action.provider];
    if (!providerCfg) {
      this.send(client, { type: 'error', sessionId: '', error: `unknown provider: ${action.provider}` });
      return;
    }

    const session = new OrcdSession({
      cwd: action.cwd,
      model: action.model,
      provider: action.provider,
      sessionId: action.sessionId, // Resume: reuse existing UUID
    });

    this.store.add(session);

    // Auto-subscribe the creating client
    const cb: SessionEventCallback = (msg) => this.send(client, msg);
    client.subscriptions.set(session.id, cb);
    session.subscribe(cb);

    // Notify client immediately with session ID
    this.send(client, { type: 'session_created', sessionId: session.id });

    // Resolve effort: action > provider > global default
    const effort = action.effort ?? providerCfg.effort ?? this.defaults.effort ?? 'high';

    // Build env for CC subprocess
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: providerCfg.baseUrl,
      ANTHROPIC_API_KEY: providerCfg.apiKey,
      ...action.env,
    };

    // Fire-and-forget: run session, clean up on exit
    session
      .run({
        prompt: action.prompt,
        resume: !!action.sessionId,
        env,
        effort,
      })
      .finally(() => {
        // Don't remove — session stays in store for history/status queries.
        // It will be removed on explicit cancel or orcd restart.
        console.log(`[orcd] session ${session.id.slice(0, 8)} exited (state=${session.state})`);
      });
  }

  private handleMessage(client: ClientState, action: OrcdAction & { action: 'message' }): void {
    const session = this.store.get(action.sessionId);
    if (!session) {
      this.send(client, { type: 'error', sessionId: action.sessionId, error: 'session not found' });
      return;
    }

    // Ensure client is subscribed
    if (!client.subscriptions.has(session.id)) {
      const cb: SessionEventCallback = (msg) => this.send(client, msg);
      client.subscriptions.set(session.id, cb);
      session.subscribe(cb);
    }

    const providerCfg = this.providers[session.provider];
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: providerCfg?.baseUrl ?? '',
      ANTHROPIC_API_KEY: providerCfg?.apiKey ?? '',
    };

    session.sendMessage(action.prompt, env).finally(() => {
      console.log(`[orcd] session ${session.id.slice(0, 8)} follow-up exited (state=${session.state})`);
    });
  }

  private handleSetEffort(action: OrcdAction & { action: 'set_effort' }): void {
    const session = this.store.get(action.sessionId);
    session?.setEffort(action.effort).catch((err) => {
      console.error(`[orcd] setEffort error:`, err);
    });
  }

  private handleSubscribe(client: ClientState, action: OrcdAction & { action: 'subscribe' }): void {
    const session = this.store.get(action.sessionId);
    if (!session) return;

    // If already subscribed, skip
    if (client.subscriptions.has(session.id)) {
      // But replay from requested index
      session.replay(action.afterEventIndex, (msg) => this.send(client, msg));
      return;
    }

    const cb: SessionEventCallback = (msg) => this.send(client, msg);
    client.subscriptions.set(session.id, cb);
    session.subscribe(cb);

    // Replay buffered events
    session.replay(action.afterEventIndex, (msg) => this.send(client, msg));
  }

  private handleUnsubscribe(client: ClientState, action: OrcdAction & { action: 'unsubscribe' }): void {
    const cb = client.subscriptions.get(action.sessionId);
    if (cb) {
      this.store.get(action.sessionId)?.unsubscribe(cb);
      client.subscriptions.delete(action.sessionId);
    }
  }

  private handleCancel(action: OrcdAction & { action: 'cancel' }): void {
    const session = this.store.get(action.sessionId);
    session?.cancel().catch((err) => {
      console.error(`[orcd] cancel error:`, err);
    });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/orcd/session-store.ts src/orcd/socket-server.ts
git commit -m "feat(orcd): add socket server and session store"
```

---

### Task 6: orcd Entry Point & Systemd Service

**Files:**

- Create: `src/orcd/index.ts`
- Create: `systemd/orcd.service` (or add to existing service setup)

- [ ] **Step 1: Create entry point**

```typescript
// src/orcd/index.ts
import { loadConfig } from './config';
import { OrcdServer } from './socket-server';
import { homedir } from 'os';

async function main() {
  console.log('[orcd] starting...');

  const config = await loadConfig();

  // Resolve ~ in socket path
  const socketPath = config.socket.replace(/^~/, homedir());

  const server = new OrcdServer(socketPath, config.providers, {
    provider: config.defaultProvider,
    model: config.defaultModel,
    effort: config.defaultEffort,
  });

  await server.start();

  // Graceful shutdown
  const shutdown = () => {
    console.log('[orcd] shutting down...');
    server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[orcd] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Create example config file**

Create `~/.orc/config.yaml` (only if it doesn't exist — don't overwrite user config):

```yaml
# ~/.orc/config.yaml
socket: ~/.orc/orcd.sock
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
defaultCwd: ~/Code
defaultEffort: high

providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_API_KEY}
    effort: high
    models:
      - claude-opus-4-6
      - claude-sonnet-4-6
      - claude-haiku-4-5-20251001

  meridian:
    baseUrl: http://127.0.0.1:3456
    apiKey: dummy
    effort: high
    models:
      - claude-opus-4-6
      - claude-sonnet-4-6

  kiro:
    baseUrl: http://127.0.0.1:3457
    apiKey: dummy
    effort: high
    models:
      - trackable:claude-sonnet-4-6
      - trackable:claude-opus-4-6
      - okkanti:claude-sonnet-4-6
```

- [ ] **Step 3: Create systemd service file**

```ini
# /etc/systemd/system/orcd.service
[Unit]
Description=orcd - Claude Code session daemon
After=network.target

[Service]
Type=simple
User=ryan
WorkingDirectory=/home/ryan/Code/orchestrel
ExecStart=/home/ryan/.local/share/pnpm/pnpm orcd
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Test orcd starts and listens**

```bash
cd /home/ryan/Code/orchestrel
pnpm orcd
# Should print: [orcd] starting... [orcd] listening on /home/ryan/.orc/orcd.sock
# Ctrl+C to stop
```

- [ ] **Step 5: Commit**

```bash
git add src/orcd/index.ts
git commit -m "feat(orcd): add entry point and systemd service"
```

---

### Task 7: OrcdClient (Orc Web Server Side)

**Files:**

- Create: `src/server/orcd-client.ts`

The web server connects to orcd as a Unix socket client. It sends actions and receives events. This replaces `SessionManager` as the session management interface for the web server.

- [ ] **Step 1: Implement OrcdClient**

```typescript
// src/server/orcd-client.ts
import { createConnection, type Socket } from 'net';
import { homedir } from 'os';
import type {
  OrcdAction,
  OrcdMessage,
  SessionCreatedMessage,
  StreamEventMessage,
  SessionResultMessage,
  SessionErrorMessage,
} from '../shared/orcd-protocol';

type MessageHandler = (msg: OrcdMessage) => void;

/**
 * Client for the orcd Unix socket.
 * Manages connection, reconnection, and message dispatch.
 */
export class OrcdClient {
  private socket: Socket | null = null;
  private buf = '';
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<MessageHandler>();

  /** Per-session callbacks for create flow */
  private createCallbacks = new Map<string, (sessionId: string) => void>();

  /** Track which sessions we consider active (running in orcd) */
  private activeSessions = new Set<string>();

  constructor(private socketPath?: string) {}

  /**
   * Connect to orcd. Reconnects automatically on disconnect.
   */
  connect(): Promise<void> {
    const path = this.socketPath ?? `${homedir()}/.orc/orcd.sock`;
    return new Promise((resolve, reject) => {
      const sock = createConnection({ path }, () => {
        this.connected = true;
        this.buf = '';
        console.log('[orcd-client] connected');
        resolve();
      });

      sock.on('data', (data) => {
        this.buf += data.toString();
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) !== -1) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line) as OrcdMessage;
            this.dispatch(msg);
          } catch {
            // skip malformed messages
          }
        }
      });

      sock.on('close', () => {
        this.connected = false;
        console.log('[orcd-client] disconnected, reconnecting in 2s...');
        this.reconnectTimer = setTimeout(() => {
          this.connect().catch((err) => {
            console.error('[orcd-client] reconnect failed:', err.message);
          });
        }, 2000);
      });

      sock.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        } else {
          console.error('[orcd-client] socket error:', err.message);
        }
      });

      this.socket = sock;
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  /**
   * Register a handler for all messages from orcd.
   */
  onMessage(handler: MessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: MessageHandler): void {
    this.handlers.delete(handler);
  }

  /**
   * Send a raw action to orcd.
   */
  send(action: OrcdAction): void {
    if (!this.socket?.writable) {
      console.error('[orcd-client] not connected, dropping action:', action.action);
      return;
    }
    this.socket.write(JSON.stringify(action) + '\n');
  }

  /**
   * Create a new session. Returns the session ID assigned by orcd.
   */
  async create(opts: {
    prompt: string;
    cwd: string;
    provider: string;
    model: string;
    effort?: string;
    sessionId?: string;
    env?: Record<string, string>;
  }): Promise<string> {
    return new Promise((resolve) => {
      // We'll resolve when we get session_created back
      const tempCb = (sessionId: string) => resolve(sessionId);

      // Send create action
      this.send({
        action: 'create',
        prompt: opts.prompt,
        cwd: opts.cwd,
        provider: opts.provider,
        model: opts.model,
        effort: opts.effort,
        sessionId: opts.sessionId,
        env: opts.env,
      });

      // The session_created message will have the sessionId.
      // We store a one-shot callback keyed by... well, we don't know the ID yet.
      // Use a special "pending" slot — we only create one session at a time per flow.
      this.createCallbacks.set('_pending', tempCb);
    });
  }

  /**
   * Send a follow-up message to an existing session.
   */
  message(sessionId: string, prompt: string): void {
    this.send({ action: 'message', sessionId, prompt });
  }

  /**
   * Cancel (abort) a session.
   */
  cancel(sessionId: string): void {
    this.send({ action: 'cancel', sessionId });
    this.activeSessions.delete(sessionId);
  }

  /**
   * Subscribe to a session's events.
   */
  subscribe(sessionId: string, afterEventIndex?: number): void {
    this.send({ action: 'subscribe', sessionId, afterEventIndex });
  }

  /**
   * Unsubscribe from a session's events.
   */
  unsubscribe(sessionId: string): void {
    this.send({ action: 'unsubscribe', sessionId });
  }

  /**
   * Change effort level for a session.
   */
  setEffort(sessionId: string, effort: string): void {
    this.send({ action: 'set_effort', sessionId, effort });
  }

  /**
   * List all active sessions.
   */
  list(): void {
    this.send({ action: 'list' });
  }

  isConnected(): boolean {
    return this.connected;
  }

  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  private dispatch(msg: OrcdMessage): void {
    // Handle session_created for pending create calls
    if (msg.type === 'session_created') {
      this.activeSessions.add(msg.sessionId);
      const cb = this.createCallbacks.get('_pending');
      if (cb) {
        this.createCallbacks.delete('_pending');
        cb(msg.sessionId);
      }
    }

    // Track session lifecycle
    if (msg.type === 'result') {
      this.activeSessions.delete(msg.sessionId);
    }

    // Forward to all registered handlers
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (err) {
        console.error('[orcd-client] handler error:', err);
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/orcd-client.ts
git commit -m "feat: add OrcdClient for web server → orcd communication"
```

---

### Task 8: Backend Bridge (Replace Session Management)

**Files:**

- Modify: `src/server/init-state.ts`
- Modify: `src/server/ws/handlers/agents.ts`
- Modify: `src/server/controllers/oc.ts`
- Modify: `src/server/ws/server.ts`
- Modify: `src/server/init.ts`
- Modify: `src/server/ws/subscriptions.ts`

This task rewires the web server to use OrcdClient instead of SessionManager. The messageBus stays for entity changes but session events now come from orcd.

- [ ] **Step 1: Update init-state.ts — replace SessionManager with OrcdClient**

Replace the SessionManager imports and functions with OrcdClient:

```typescript
// src/server/init-state.ts
import type { Server as HttpServer } from 'http';
import type { Http2SecureServer } from 'http2';
import type { Server as IoServer } from 'socket.io';

type AnyHttpServer = HttpServer | Http2SecureServer;

/** OrcdClient — survives Vite restarts. */
import type { OrcdClient } from './orcd-client';
let _orcdClient: OrcdClient | null = null;
export function getOrcdClient(): OrcdClient | null {
  return _orcdClient;
}
export function setOrcdClient(client: OrcdClient): void {
  _orcdClient = client;
}

/** True after IO server, bus listeners, and OrcdClient are initialized. */
export let initialized = false;
export function markInitialized() {
  initialized = true;
}

/** Cached Socket.IO Server — reused across Vite restarts. */
export let io: IoServer | null = null;
export function setIo(instance: IoServer) {
  io = instance;
}

/** httpServer from server.js — arrives via process event, persists across restarts. */
let _httpServer: AnyHttpServer | null = null;
const _httpServerReady = new Promise<AnyHttpServer>((resolve) => {
  if (_httpServer) {
    resolve(_httpServer);
    return;
  }
  process.once('orchestrel:httpServer', (server: AnyHttpServer) => {
    _httpServer = server;
    resolve(server);
  });
});

export function getHttpServer(): Promise<AnyHttpServer> {
  if (_httpServer) return Promise.resolve(_httpServer);
  return _httpServerReady;
}
```

- [ ] **Step 2: Update agents.ts handlers — use OrcdClient**

```typescript
// src/server/ws/handlers/agents.ts
import type { AckResponse } from '../../../shared/ws-protocol';
import { Card } from '../../models/Card';
import { buildPromptWithFiles } from '../../sessions/manager';
import { registerCardSession } from '../../controllers/oc';
import { ensureWorktree } from '../../sessions/worktree';

export async function handleAgentSend(
  data: {
    cardId: number;
    message: string;
    files?: Array<{ id: string; name: string; mimeType: string; path: string; size: number }>;
  },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId, message, files } = data;
  console.log(`[session:${cardId}] agent:send, len=${message.length}`);

  try {
    callback({});

    const initState = await import('../../init-state');
    const client = initState.getOrcdClient();
    if (!client) throw new Error('OrcdClient not initialized');

    const card = await Card.findOneByOrFail({ id: cardId });
    const prompt = buildPromptWithFiles(message, files);

    if (card.sessionId && client.isActive(card.sessionId)) {
      // Follow-up to active session
      client.message(card.sessionId, prompt);
    } else {
      // New session or resume
      const cwd = await ensureWorktree(card);
      const sessionId = await client.create({
        prompt,
        cwd,
        provider: card.provider,
        model: card.model,
        sessionId: card.sessionId ?? undefined, // Resume if exists
      });

      card.sessionId = sessionId;
      registerCardSession(cardId, sessionId);

      if (card.column !== 'running') {
        card.column = 'running';
      }
      card.updatedAt = new Date().toISOString();
      await card.save();
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[session:${cardId}] agent:send error:`, error);
  }
}

export async function handleAgentCompact(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  const { cardId } = data;
  console.log(`[session:${cardId}] agent:compact received`);
  try {
    callback({});
    const initState = await import('../../init-state');
    const client = initState.getOrcdClient();
    const card = await Card.findOneBy({ id: cardId });
    if (client && card?.sessionId && client.isActive(card.sessionId)) {
      client.message(
        card.sessionId,
        'Please compact your context window. Summarize the conversation so far and continue.',
      );
    }
  } catch (err) {
    console.error(`[session:${cardId}] agent:compact error:`, err);
  }
}

export async function handleAgentStop(data: { cardId: number }, callback: (res: AckResponse) => void): Promise<void> {
  const { cardId } = data;
  console.log(`[session:${cardId}] agent:stop received`);
  callback({});
  const initState = await import('../../init-state');
  const client = initState.getOrcdClient();
  const card = await Card.findOneBy({ id: cardId });
  if (client && card?.sessionId) {
    client.cancel(card.sessionId);
  }
}

export async function handleAgentStatus(
  data: { cardId: number },
  callback: (res: AckResponse) => void,
  socket: import('../types').AppSocket,
): Promise<void> {
  const { cardId } = data;
  try {
    const initState = await import('../../init-state');
    const client = initState.getOrcdClient();
    const card = await Card.findOneBy({ id: cardId });

    const active = !!(card?.sessionId && client?.isActive(card.sessionId));

    socket.emit('agent:status', {
      cardId,
      active,
      status: active ? 'running' : 'completed',
      sessionId: card?.sessionId ?? null,
      promptsSent: card?.promptsSent ?? 0,
      turnsCompleted: card?.turnsCompleted ?? 0,
      contextTokens: card?.contextTokens ?? 0,
      contextWindow: card?.contextWindow ?? 200_000,
    });
    callback({});
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
```

- [ ] **Step 3: Update oc.ts — bridge orcd events to messageBus + DB persistence**

The key change: `registerCardSession` now takes a `sessionId` and listens to orcd events via the OrcdClient handler, rather than subscribing to messageBus topics published by `consumeSession`.

```typescript
// src/server/controllers/oc.ts
import { Card } from '../models/Card';
import { Project } from '../models/Project';
import { messageBus, type MessageBus } from '../bus';
import { AppDataSource } from '../models/index';
import { processQueue } from '../services/queue-gate';
import type { OrcdMessage } from '../../shared/orcd-protocol';

/**
 * Register per-card session event handlers.
 * Listens to OrcdClient messages for the given sessionId and:
 * - Forwards SDK events to card's messageBus topic (for Socket.IO bridge)
 * - Persists session counters to DB on result
 * - Moves card to review on session exit
 */
export function registerCardSession(cardId: number, sessionId: string): void {
  const repo = AppDataSource.getRepository(Card);
  let registered = true;

  const handler = async (msg: OrcdMessage) => {
    if (!registered) return;

    // Only handle events for our session
    if (!('sessionId' in msg) || msg.sessionId !== sessionId) return;

    if (msg.type === 'stream_event') {
      const sdkEvent = msg.event as Record<string, unknown>;

      // Forward to messageBus for Socket.IO bridge
      messageBus.publish(`card:${cardId}:sdk`, sdkEvent);

      // Handle compact boundary
      if (sdkEvent.type === 'system' && (sdkEvent as Record<string, unknown>).subtype === 'compact_boundary') {
        const card = await repo.findOneBy({ id: cardId });
        if (card) {
          card.contextTokens = 0;
          card.updatedAt = new Date().toISOString();
          await repo.save(card);
        }
      }
    }

    if (msg.type === 'result') {
      const result = msg.result as Record<string, unknown>;
      messageBus.publish(`card:${cardId}:sdk`, result);

      // Persist to DB
      const card = await repo.findOneBy({ id: cardId });
      if (card) {
        card.turnsCompleted = (card.turnsCompleted ?? 0) + 1;
        card.updatedAt = new Date().toISOString();
        await repo.save(card);
      }

      // Move to review + queue processing
      await handleSessionExit(cardId);
      unregister();
    }

    if (msg.type === 'error') {
      messageBus.publish(`card:${cardId}:sdk`, {
        type: 'error',
        message: msg.error,
        timestamp: Date.now(),
      });

      await handleSessionExit(cardId);
      unregister();
    }
  };

  const unregister = async () => {
    registered = false;
    const initState = await import('../init-state');
    const client = initState.getOrcdClient();
    client?.offMessage(handler);
  };

  // Register handler on OrcdClient
  import('../init-state').then((initState) => {
    const client = initState.getOrcdClient();
    client?.onMessage(handler);
  });
}

async function handleSessionExit(cardId: number): Promise<void> {
  const repo = AppDataSource.getRepository(Card);
  const card = await repo.findOneBy({ id: cardId });

  if (card && card.column === 'running') {
    card.column = 'review';
    card.updatedAt = new Date().toISOString();
    await repo.save(card);
  }

  // Process queue for non-worktree cards
  const freshCard = await repo.findOneBy({ id: cardId });
  if (freshCard && !freshCard.worktreeBranch && freshCard.projectId) {
    processQueue(freshCard.projectId).catch((err) => {
      console.error(`[oc:${cardId}] processQueue failed on exit:`, err);
    });
  }

  messageBus.publish(`card:${cardId}:exit`, {
    sessionId: card?.sessionId,
    status: 'completed',
  });
}

export function registerAutoStart(bus: MessageBus = messageBus): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;

    // Card entered running
    if (newColumn === 'running' && oldColumn !== 'running') {
      const initState = await import('../init-state');
      const client = initState.getOrcdClient();
      if (!client) return;

      const fullCard = await repo().findOneBy({ id: card.id });
      if (!fullCard) return;

      // Check if already active in orcd
      if (fullCard.sessionId && client.isActive(fullCard.sessionId)) return;

      // Non-worktree cards on git repos: delegate to queue processing
      if (!fullCard.worktreeBranch && fullCard.projectId) {
        const proj = await Project.findOneBy({ id: fullCard.projectId });
        if (proj?.isGitRepo) {
          processQueue(fullCard.projectId).catch((err) => {
            console.error(`[oc:auto-start] processQueue failed for card #${card.id}:`, err);
          });
          return;
        }
      }

      // Direct start (worktree or no project)
      const { ensureWorktree } = await import('../sessions/worktree');
      const cwd = await ensureWorktree(fullCard);
      const prompt = fullCard.pendingPrompt ?? (fullCard.sessionId ? '' : (fullCard.description ?? ''));
      fullCard.pendingPrompt = null;
      fullCard.pendingFiles = null;
      await repo().save(fullCard);

      const sessionId = await client.create({
        prompt,
        cwd,
        provider: fullCard.provider,
        model: fullCard.model,
        sessionId: fullCard.sessionId ?? undefined,
      });

      fullCard.sessionId = sessionId;
      fullCard.updatedAt = new Date().toISOString();
      await repo().save(fullCard);

      registerCardSession(fullCard.id, sessionId);
    }

    // Card left running: cancel session
    if (oldColumn === 'running' && newColumn !== 'running') {
      const initState = await import('../init-state');
      const client = initState.getOrcdClient();
      if (card.sessionId) {
        client?.cancel(card.sessionId);
      }

      if (!card.worktreeBranch && card.projectId) {
        const proj = await Project.findOneBy({ id: card.projectId });
        if (proj?.isGitRepo) {
          processQueue(card.projectId).catch((err) => {
            console.error(`[oc:auto-start] processQueue failed for project ${card.projectId}:`, err);
          });
        }
      }
    }
  });
}

export function registerWorktreeCleanup(bus: MessageBus = messageBus): void {
  bus.subscribe('board:changed', async (payload) => {
    const { card, oldColumn, newColumn } = payload as {
      card: Card | null;
      oldColumn: string | null;
      newColumn: string | null;
    };
    if (!card) return;
    if (newColumn !== 'archive' || oldColumn === 'archive') return;

    const c = card as Card;
    if (!c.worktreeBranch || !c.projectId) return;

    try {
      const proj = await Project.findOneBy({ id: c.projectId });
      if (!proj) return;

      const { resolveWorkDir } = await import('../../shared/worktree');
      const wtPath = resolveWorkDir(c.worktreeBranch, proj.path);
      const { removeWorktree, worktreeExists } = await import('../worktree');
      if (worktreeExists(wtPath)) {
        removeWorktree(proj.path, wtPath);
        console.log(`[oc:worktree] removed ${wtPath}`);
      }
    } catch (err) {
      console.error(`[oc:worktree] cleanup failed for card ${c.id}:`, err);
    }
  });
}

function repo() {
  return AppDataSource.getRepository(Card);
}
```

- [ ] **Step 4: Update ws/server.ts and init.ts — initialize OrcdClient instead of SessionManager**

In the dev-mode setup (`src/server/ws/server.ts`), inside the `configureServer` hook where `SessionManager` is created, replace with:

```typescript
// In the initialization block (guarded by init-state.initialized):
const { OrcdClient } = await import('../server/orcd-client');
const orcdClient = new OrcdClient();
await orcdClient.connect();
initState.setOrcdClient(orcdClient);
```

Similarly, in the production setup (`src/server/init.ts`):

```typescript
const { OrcdClient } = await import('./orcd-client');
const orcdClient = new OrcdClient();
await orcdClient.connect();
const { setOrcdClient } = await import('./init-state');
setOrcdClient(orcdClient);
```

- [ ] **Step 5: Commit**

```bash
git add src/server/init-state.ts src/server/ws/handlers/agents.ts src/server/controllers/oc.ts src/server/ws/server.ts src/server/init.ts
git commit -m "feat: wire OrcdClient into web server, replace SessionManager"
```

---

### Task 9: History Loading via Agent SDK

**Files:**

- Modify: `src/server/ws/handlers/sessions.ts`

Replace the JSONL reader with the Agent SDK's `getSessionMessages()` function. This runs in the web server process (not orcd) since it just reads files from disk.

- [ ] **Step 1: Update handleSessionLoad**

```typescript
// src/server/ws/handlers/sessions.ts
import type { AckResponse } from '../../../shared/ws-protocol';
import type { AppSocket } from '../types';
import { busRoomBridge } from '../subscriptions';
import { Card } from '../../models/Card';
import { Project } from '../../models/Project';
import { resolveWorkDir } from '../../../shared/worktree';

export async function handleSessionLoad(
  data: { cardId: number; sessionId?: string },
  callback: (res: AckResponse<{ messages: unknown[] }>) => void,
  socket: AppSocket,
): Promise<void> {
  const { cardId } = data;

  try {
    const room = `card:${cardId}`;
    const alreadyJoined = socket.rooms.has(room);
    console.log(`[session:load] cardId=${cardId} alreadyJoined=${alreadyJoined}`);

    let messages: unknown[] = [];
    const card = await Card.findOneBy({ id: cardId });

    if (card?.sessionId && card.projectId) {
      const proj = await Project.findOneBy({ id: card.projectId });
      if (proj) {
        const cwd = resolveWorkDir(card.worktreeBranch ?? null, proj.path);
        try {
          const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
          const sessionMsgs = await getSessionMessages(card.sessionId, {
            dir: cwd,
          });
          messages = sessionMsgs;
          console.log(`[session:load] cardId=${cardId} loaded ${messages.length} messages via SDK`);
        } catch (err) {
          console.warn(`[session:load] cardId=${cardId} SDK getSessionMessages failed:`, err);
        }
      }
    }

    // Join the card room for live events
    if (!alreadyJoined) {
      socket.join(room);
      busRoomBridge.ensureCardListeners(cardId);
      console.log(`[session:load] cardId=${cardId} joined room ${room}`);
    }

    // Also subscribe to orcd for live events (if session is active)
    if (card?.sessionId) {
      const initState = await import('../../init-state');
      const client = initState.getOrcdClient();
      if (client?.isActive(card.sessionId)) {
        client.subscribe(card.sessionId);
      }
    }

    callback({ data: { messages } });
  } catch (err) {
    console.error(`[session:load] error loading session:`, err);
    callback({ error: `Failed to load session: ${err}` });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/ws/handlers/sessions.ts
git commit -m "feat: load session history via Agent SDK getSessionMessages()"
```

---

### Task 10: Frontend Type Alignment

**Files:**

- Modify: `app/lib/sdk-types.ts`
- Modify: `app/lib/message-accumulator.ts`

The frontend types already closely match Agent SDK output. Minor updates needed:

- Agent SDK `SDKResultMessage` has `modelUsage` (not `model_usage`) — check and align field names.
- Agent SDK `SDKPartialAssistantMessage` uses `type: 'stream_event'` which already matches.
- Add handling for `SDKUserMessageReplay` (type: 'user') for resumed sessions showing replayed history.

- [ ] **Step 1: Update sdk-types.ts**

Add `SDKUserMessageReplay` handling and ensure `SdkResultMessage` matches SDK output:

In `src/app/lib/sdk-types.ts`, update the `SdkResultMessage` interface:

```typescript
// Change model_usage to modelUsage to match SDK output:
export interface SdkResultMessage {
  type: 'result';
  subtype:
    | 'success'
    | 'error_max_turns'
    | 'error_during_execution'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries';
  result?: string;
  total_cost_usd: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  num_turns: number;
  duration_ms: number;
  duration_api_ms?: number;
  modelUsage?: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }>;
  // Keep model_usage as alias for backwards compat with any existing history
  model_usage?: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }>;
}
```

- [ ] **Step 2: Update message-accumulator.ts result handler**

In the `handleResult` method, accept both `modelUsage` and `model_usage`:

```typescript
// In handleResult method, change the modelUsage extraction:
const rawUsage = msg.modelUsage ?? msg.model_usage;
modelUsage: rawUsage
  ? Object.fromEntries(
      Object.entries(rawUsage).map(([k, v]) => [
        k,
        { inputTokens: v?.input_tokens ?? 0, outputTokens: v?.output_tokens ?? 0, costUsd: v?.cost_usd ?? 0 },
      ]),
    )
  : undefined,
```

- [ ] **Step 3: Commit**

```bash
git add app/lib/sdk-types.ts app/lib/message-accumulator.ts
git commit -m "fix: align frontend SDK types with Agent SDK output format"
```

---

### Task 11: Dead Code Removal

**Files:**

- Delete: `src/server/sessions/consumer.ts`
- Delete: `src/server/sessions/meridian-client.ts`
- Delete: `src/server/sessions/event-translator.ts`
- Delete: `src/server/sessions/sse-parser.ts`
- Delete: `src/server/sessions/jsonl-reader.ts`
- Modify: `src/server/sessions/manager.ts` — keep only `buildPromptWithFiles` (used by agents.ts), remove `SessionManager` class

- [ ] **Step 1: Slim down manager.ts to utility function only**

```typescript
// src/server/sessions/manager.ts
import { resolve } from 'path';
import type { FileRef } from '../../shared/ws-protocol';

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
```

- [ ] **Step 2: Delete dead files**

```bash
rm src/server/sessions/consumer.ts
rm src/server/sessions/meridian-client.ts
rm src/server/sessions/event-translator.ts
rm src/server/sessions/sse-parser.ts
rm src/server/sessions/jsonl-reader.ts
```

- [ ] **Step 3: Update types.ts — remove meridian-specific fields**

```typescript
// src/server/sessions/types.ts
export type SessionStatus = 'starting' | 'running' | 'completed' | 'errored' | 'stopped' | 'retry';

export interface SessionStartOpts {
  provider: string;
  model: string;
  resume?: string;
}
```

Remove `ActiveSession`, `Usage`, and `meridianSessionId` — these are no longer needed since orcd owns session state.

- [ ] **Step 4: Remove Card.ts meridian sessionId guard**

In `src/server/models/Card.ts`, the `beforeUpdate` hook has a guard that prevents overwriting non-`msg_` sessionIds. With orcd, sessionIds are always real CC UUIDs from the start. Remove the `msg_` check:

```typescript
// In beforeUpdate, replace the sessionId immutability check with:
if (prev?.sessionId && card.sessionId !== prev.sessionId) {
  // Allow overwriting only if the old ID matches the new session's resume
  console.log(`[card:${card.id}] sessionId changed: ${prev.sessionId} → ${card.sessionId}`);
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove meridian session backend, slim types"
```

---

### Task 12: KPP Effort/Thinking Support

**Files (in `/home/ryan/Code/kiro-pool-proxy/`):**

- Modify: `src/proxy/types.ts`
- Modify: `src/proxy/convert-request.ts`
- Modify: `tests/convert-request.test.ts`

This task is fully independent — different repo, different codebase.

- [ ] **Step 1: Write failing test**

```typescript
// tests/convert-request.test.ts — add to existing test file:

it('passes thinking budget to CW request', () => {
  const req: AnthropicRequest = {
    model: 'claude-sonnet-4.6',
    max_tokens: 8192,
    thinking: { type: 'enabled', budget_tokens: 5000 },
    messages: [{ role: 'user', content: 'Solve this complex problem' }],
  };
  const cw = convertRequest(req, profileArn);
  expect(cw.conversationState.thinkingConfig).toEqual({
    thinkingBudget: 5000,
  });
});

it('omits thinkingConfig when thinking is disabled', () => {
  const req: AnthropicRequest = {
    model: 'claude-sonnet-4.6',
    max_tokens: 8192,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'Quick question' }],
  };
  const cw = convertRequest(req, profileArn);
  expect(cw.conversationState.thinkingConfig).toBeUndefined();
});

it('handles adaptive thinking (no budget)', () => {
  const req: AnthropicRequest = {
    model: 'claude-sonnet-4.6',
    max_tokens: 8192,
    thinking: { type: 'enabled' },
    messages: [{ role: 'user', content: 'Think about this' }],
  };
  const cw = convertRequest(req, profileArn);
  // Adaptive: no explicit budget → omit thinkingConfig (let CW decide)
  expect(cw.conversationState.thinkingConfig).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/ryan/Code/kiro-pool-proxy
npm test
```

Expected: 3 new tests FAIL.

- [ ] **Step 3: Update types**

In `src/proxy/types.ts`, add to the `AnthropicRequest` interface:

```typescript
// Add to AnthropicRequest:
thinking?: {
  type: 'enabled' | 'disabled';
  budget_tokens?: number;
};
```

Add to the CW request type (or create inline — depends on how CWRequest is structured):

```typescript
// In the CW conversationState type, add:
thinkingConfig?: {
  thinkingBudget: number;
};
```

- [ ] **Step 4: Update convertRequest()**

In `src/proxy/convert-request.ts`, at the end of the `convertRequest` function where the CW request object is built, add thinking config mapping:

```typescript
// After building the base cwRequest, before returning:
const thinkingConfig = buildThinkingConfig(req.thinking);

// Include in the returned object's conversationState:
...(thinkingConfig ? { thinkingConfig } : {}),
```

Add the helper function:

```typescript
function buildThinkingConfig(thinking: AnthropicRequest['thinking']): { thinkingBudget: number } | undefined {
  if (!thinking) return undefined;
  if (thinking.type === 'disabled') return undefined;
  if (!thinking.budget_tokens) return undefined; // Adaptive — no explicit budget
  return { thinkingBudget: thinking.budget_tokens };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/ryan/Code/kiro-pool-proxy
git add src/proxy/types.ts src/proxy/convert-request.ts tests/convert-request.test.ts
git commit -m "feat: add thinking/effort support to CW request conversion"
```

---

## Self-Review

### Spec Coverage Check

| Spec Requirement                              | Task                                                    |
| --------------------------------------------- | ------------------------------------------------------- |
| orcd daemon with Unix socket                  | Tasks 4-6                                               |
| Agent SDK query() + resume                    | Task 4                                                  |
| Newline-delimited JSON protocol               | Tasks 1, 5, 7                                           |
| Ring buffer for reconnection                  | Task 2, used in Task 5                                  |
| Session lifecycle (create, follow-up, cancel) | Tasks 4-5                                               |
| Event streaming to subscribers                | Task 5                                                  |
| Provider config YAML                          | Task 3                                                  |
| Env var interpolation                         | Task 3                                                  |
| Effort levels + runtime changes               | Tasks 3, 4, 5                                           |
| Orc connects to orcd                          | Task 7                                                  |
| Replace SessionManager                        | Task 8                                                  |
| History via getSessionMessages()              | Task 9                                                  |
| Frontend type alignment                       | Task 10                                                 |
| Remove meridian code                          | Task 11                                                 |
| KPP effort/thinking                           | Task 12                                                 |
| Worktree support                              | Task 8 (ensureWorktree still called)                    |
| Queue processing                              | Task 8 (processQueue still called)                      |
| Session discovery on reconnect                | Task 7 (OrcdClient.list())                              |
| CC TUI interop                                | Inherent — CC sessions have standard UUIDs, JSONL files |
| settingSources: ["user", "project"]           | Task 4                                                  |
| permissionMode: bypassPermissions             | Task 4                                                  |
| includePartialMessages: true                  | Task 4                                                  |

### Type Consistency Check

- `OrcdAction` / `OrcdMessage` used consistently in protocol.ts, socket-server.ts, orcd-client.ts
- `SessionState` used in types.ts and session.ts
- `ProviderConfig` used in config.ts and socket-server.ts
- `SessionEventCallback` used in session.ts and socket-server.ts
- `buildPromptWithFiles` kept in manager.ts, imported by agents.ts — consistent

### Placeholder Scan

No TBD/TODO/placeholder patterns found. All code blocks contain complete implementations.

---

## Execution

Plan saved to `docs/superpowers/plans/2026-04-10-orcd-architecture.md`.

**Parallelism map for agent teams:**

| Stream        | Tasks            | Dependencies                     | Can start immediately     |
| ------------- | ---------------- | -------------------------------- | ------------------------- |
| A: orcd core  | 1, 2, 3, 4, 5, 6 | Task 4 needs 1,2; Task 5 needs 4 | Yes (1, 2, 3 in parallel) |
| B: Orc rewire | 7, 8, 9, 10      | Needs Task 1 types               | After Task 1              |
| C: Cleanup    | 11               | After A + B                      | After A + B               |
| D: KPP        | 12               | None                             | Yes                       |

**Teammate assignment:**

- **Teammate 1:** Tasks 1-6 (orcd daemon, in `src/orcd/`)
- **Teammate 2:** Task 12 (KPP, in `/home/ryan/Code/kiro-pool-proxy/`)
- **Teammate 3:** Tasks 7-10 (Orc rewire, in `src/server/` + `app/`)
- **Lead:** Task 11 (cleanup) + integration testing after all teammates complete
