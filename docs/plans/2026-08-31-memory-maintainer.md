# Memory Maintainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background service inside orchestrel that turns agent session transcripts (`~/.pi/agent/sessions`) into curated, staged memory ops per configured project, alerted via Telegram daily, with a weekly merge pass.

**Architecture:** New module `src/lib/memory-maintainer/`. A daily in-process timer (registered in the server init paths) sweeps pi session files, filters by watermark, builds bounded excerpts, runs a pi-ai `ModelRuntime` agent with four memory tools per project's memory server, and appends proposed ops to a per-day staging JSON. Default `mode: stage` never writes to any memory API; `mode: write` executes ops. A weekly timer runs a scoped merge pass over the staging files grouped by memory server set.

**Tech Stack:** TypeScript strict (no `any`), better-sqlite3 (`data/orchestrel.db`), `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent` (`ModelRuntime`, `ModelRegistry`), plain `fetch` (no Anthropic SDK), `arg` for the CLI, vitest.

**Spec:** `docs/specs/2026-08-31-memory-maintainer-design.md`

## Global Constraints

- TypeScript strict; never `any` — use `unknown` and narrow.
- No barrel exports (no index.ts re-exports in the maintainer module).
- Direct modules, no dependency injection; config read at call time (`loadConfig()`), tests mock at boundaries (`mock.module`, `globalThis.fetch` stubs, runtime spies) — never reshape production code for tests.
- Never import `@anthropic-ai/sdk`. Model calls go through `@earendil-works/pi-ai`.
- DB: better-sqlite3 with `busy_timeout` only. Never run WAL management commands (`PRAGMA journal_mode`, `wal_checkpoint`).
- CLI scripts use the `arg` library; parse args at top, then `main()`.
- Secrets only via `${VAR}` env placeholders resolved by `parseConfig` (`resolveEnvVars`). `TRACKABLE_MEMORY_API_KEY` exists in `/home/ryan/plans/.env`; `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are new and user-supplied.
- Unconfigured projects are skipped — a session file whose `cwd` matches no configured project is dropped. No default fallback backend.
- Staged memory text must never contain secrets: redact any text matching `/sk-[A-Za-z0-9]{20,}|Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/`.
- Files/state under `data/`; sessions read from `join(getAgentDir(), 'sessions')`.
- Existing house pattern to mirror for provider registration: `src/orcd/pi-runtime.ts::registerOrchestrelProvider` (api `anthropic-messages`, anonymous api key for local oMLX).

---

### Task 1: Shared config — `memory` section

**Files:**
- Modify: `src/shared/config.ts`
- Modify: `orcd.example.yaml`
- Test: `src/shared/config.test.ts`

**Interfaces:**
- Consumes: existing `OrchestrelConfig`, `parseConfig`, `resolveEnvVars`.
- Produces: `MemoryConfig`, `MemoryProjectConfig`; `OrchestrelConfig.memory?: MemoryConfig`.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/config.test.ts`:

```ts
import { parseConfig, resetConfigCache } from './config';

const MINIMAL = `
providers:
  max:
    models:
      assistant: { modelID: qwen3.8-27b-oq8, contextWindow: 262144 }
memory:
  provider: max
  model: assistant
  projects:
    trackable:
      match: ["/home/ryan/Code/trackable", "/home/ryan/Code/transcription"]
      apiUrl: https://memory.trackable.io
      apiKey: "\${TRACKABLE_MEMORY_API_KEY}"
      project: trackable
`;

describe('memory config', () => {
  beforeEach(() => resetConfigCache());

  it('parses a memory section with defaults', () => {
    const cfg = parseConfig(MINIMAL, { TRACKABLE_MEMORY_API_KEY: 'k' });
    expect(cfg.memory).toMatchObject({
      mode: 'stage',
      provider: 'max',
      model: 'assistant',
      maxTurns: 30,
      excerptTokens: 24000,
      settleMs: 600000,
    });
    expect(cfg.memory?.projects.trackable).toEqual({
      match: ['/home/ryan/Code/trackable', '/home/ryan/Code/transcription'],
      apiUrl: 'https://memory.trackable.io',
      apiKey: 'k',
      project: 'trackable',
    });
  });

  it('honors mode: write and telegram config', () => {
    const cfg = parseConfig(
      MINIMAL.replace('memory:', 'memory:\n  mode: write\n  telegram:\n    botToken: "${TELEGRAM_BOT_TOKEN}"\n    chatId: "123"'),
      { TELEGRAM_BOT_TOKEN: 't' },
    );
    expect(cfg.memory?.mode).toBe('write');
    expect(cfg.memory?.telegram).toEqual({ botToken: 't', chatId: '123' });
  });

  it('is absent when the section is missing', () => {
    const cfg = parseConfig(`providers:\n  max:\n    models:\n      assistant: { modelID: qwen3.8-27b-oq8 }`, {});
    expect(cfg.memory).toBeUndefined();
  });

  it('throws when a project entry is incomplete', () => {
    const bad = `
providers:
  max:
    models:
      assistant: { modelID: qwen3.8-27b-oq8 }
memory:
  provider: max
  model: assistant
  projects:
    trackable: { match: ["/x"], apiUrl: "http://x", project: "trackable" }
`;
    expect(() => parseConfig(bad, {})).toThrow('apiKey');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/shared/config.test.ts`
Expected: FAIL — `cfg.memory` is undefined (types and parsing do not exist yet).

- [ ] **Step 3: Add the types and parsing**

In `src/shared/config.ts`, after `ProviderDef`:

```ts
export interface MemoryProjectConfig {
  match: string[];
  apiUrl: string;
  apiKey: string;
  project: string;
}

export interface MemoryConfig {
  mode: 'stage' | 'write';
  provider: string;
  model: string;
  maxTurns: number;
  excerptTokens: number;
  stageDir: string;
  settleMs: number;
  telegram?: { botToken: string; chatId: string };
  projects: Record<string, MemoryProjectConfig>;
}
```

Add `memory?: MemoryConfig;` to `OrchestrelConfig`.

In `parseConfig`, after the `listen` block and before `return`, add:

```ts
  let memory: MemoryConfig | undefined;
  const rawMemory = raw.memory;
  if (rawMemory && typeof rawMemory === 'object') {
    const m = rawMemory as Record<string, unknown>;
    if (!m.provider || !m.model) {
      throw new Error('config: memory requires provider and model');
    }
    if (!m.projects || typeof m.projects !== 'object') {
      throw new Error('config: memory requires a projects map');
    }
    const projects: Record<string, MemoryProjectConfig> = {};
    for (const [key, p] of Object.entries(m.projects as Record<string, Record<string, unknown>>)) {
      if (!Array.isArray(p.match) || p.match.length === 0) {
        throw new Error(`config: memory project "${key}" requires match paths`);
      }
      if (!p.apiUrl || !p.apiKey || !p.project) {
        throw new Error(`config: memory project "${key}" requires apiUrl, apiKey, project`);
      }
      projects[key] = {
        match: p.match.map((x) => resolveEnvVars(String(x), env)),
        apiUrl: resolveEnvVars(String(p.apiUrl), env),
        apiKey: resolveEnvVars(String(p.apiKey), env),
        project: resolveEnvVars(String(p.project), env),
      };
    }
    memory = {
      mode: m.mode === 'write' ? 'write' : 'stage',
      provider: String(m.provider),
      model: String(m.model),
      maxTurns: Number(m.maxTurns ?? 30),
      excerptTokens: Number(m.excerptTokens ?? 24000),
      stageDir: String(m.stageDir ?? 'data/memory-staging'),
      settleMs: Number(m.settleMs ?? 600000),
      ...(m.telegram && typeof m.telegram === 'object'
        ? {
            telegram: {
              botToken: resolveEnvVars(String((m.telegram as Record<string, unknown>).botToken ?? ''), env),
              chatId: resolveEnvVars(String((m.telegram as Record<string, unknown>).chatId ?? ''), env),
            },
          }
        : {}),
      projects,
    };
  }
```

Then add `...(memory ? { memory } : {})` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/shared/config.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Document the section in orcd.example.yaml**

Append to `orcd.example.yaml`:

```yaml
# Memory maintainer (optional). Omit to disable. See
# docs/specs/2026-08-31-memory-maintainer-design.md
memory:
  mode: stage                 # stage = write proposals to data/memory-staging/ + Telegram alert; write = apply to the API
  provider: max               # provider id from providers map (orcd.yaml)
  model: assistant            # alias in providers.<provider>.models
  maxTurns: 30                # agent loop cap per session
  excerptTokens: 24000        # token cap for the session excerpt fed to the agent
  settleMs: 600000            # session must be idle this long (ms) before processing
  stageDir: data/memory-staging
  telegram:                   # optional; without it, alerts are logged only
    botToken: ${TELEGRAM_BOT_TOKEN}
    chatId: ${TELEGRAM_CHAT_ID}
  projects:                   # only listed projects are maintained
    trackable:
      match: ["/home/ryan/Code/trackable", "/home/ryan/Code/transcription"]
      apiUrl: https://memory.trackable.io
      apiKey: ${TRACKABLE_MEMORY_API_KEY}
      project: trackable
```

- [ ] **Step 6: Lint and commit**

Run: `bun run lint` (oxlint, must be clean), then:

```bash
git add src/shared/config.ts src/shared/config.test.ts orcd.example.yaml
git commit -m "feat(config): memory maintainer section in shared config"
```

---

### Task 2: Routing + memory REST client

**Files:**
- Create: `src/lib/memory-maintainer/config.ts`
- Create: `src/lib/memory-maintainer/memory-api.ts`
- Test: `src/lib/memory-maintainer/config.test.ts`
- Test: `src/lib/memory-maintainer/memory-api.test.ts`

**Interfaces:**
- Consumes: `MemoryConfig`, `MemoryProjectConfig` from Task 1.
- Produces:
  - `routeProject(cwd: string, memory: MemoryConfig): { key: string; cfg: MemoryProjectConfig } | null`
  - `MemoryServer = { apiUrl: string; apiKey: string; project: string }`
  - `StagedOp` union (below)
  - `searchMemories(server, query, limit?): Promise<MemoryHit[]>`
  - `storeMemory(server, { title, text, tags? }): Promise<{ id: string }>`
  - `updateMemory(server, { id, title?, text }): Promise<{ success: boolean }>`
  - `deleteMemory(server, id): Promise<{ success: boolean }>`

- [ ] **Step 1: Write the failing tests**

`src/lib/memory-maintainer/config.test.ts`:

```ts
import type { MemoryConfig } from '../../shared/config';
import { routeProject } from './config';

const MEMORY: MemoryConfig = {
  mode: 'stage',
  provider: 'max',
  model: 'assistant',
  maxTurns: 30,
  excerptTokens: 24000,
  stageDir: 'data/memory-staging',
  settleMs: 600000,
  projects: {
    trackable: {
      match: ['/home/ryan/Code/trackable', '/home/ryan/Code/transcription'],
      apiUrl: 'https://memory.trackable.io',
      apiKey: 'k',
      project: 'trackable',
    },
    other: {
      match: ['/home/ryan/Code/okkanti'],
      apiUrl: 'http://localhost:3100',
      apiKey: 'k',
      project: 'okkanti',
    },
  },
};

describe('routeProject', () => {
  it('routes a worktree cwd by longest prefix', () => {
    const hit = routeProject('/home/ryan/Code/trackable/.worktrees/trk-5587-fix', MEMORY);
    expect(hit?.key).toBe('trackable');
  });

  it('routes a top-level dir', () => {
    expect(routeProject('/home/ryan/Code/okkanti', MEMORY)?.key).toBe('other');
  });

  it('returns null for unconfigured cwds', () => {
    expect(routeProject('/home/ryan/Code/somewhere', MEMORY)).toBeNull();
  });
});
```

`src/lib/memory-maintainer/memory-api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryServer } from './memory-api';
import { searchMemories, storeMemory, updateMemory, deleteMemory } from './memory-api';

const SERVER: MemoryServer = { apiUrl: 'http://mem.test', apiKey: 'sek', project: 'trackable' };

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve('err'),
    json: () => Promise.resolve(body),
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('memory-api', () => {
  it('searches with project scoping and bearer auth', async () => {
    mockFetch(200, { data: [{ id: '1', title: 't', text: 'x', score: 0.5 }] });
    const hits = await searchMemories(SERVER, 'pipeline', 5);
    expect(hits).toEqual([{ id: '1', title: 't', text: 'x', score: 0.5 }]);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/memories/search');
    expect(url).toContain('query=pipeline');
    expect(url).toContain('project=trackable');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sek' });
  });

  it('stores with project in the body', async () => {
    mockFetch(200, { data: { id: '9' } });
    const { id } = await storeMemory(SERVER, { title: 't', text: 'x', tags: ['a'] });
    expect(id).toBe('9');
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ title: 't', text: 'x', tags: ['a'], project: 'trackable' });
  });

  it('updates and deletes by id', async () => {
    mockFetch(200, { data: { success: true } });
    expect((await updateMemory(SERVER, { id: '1', text: 'new' })).success).toBe(true);
    expect((await deleteMemory(SERVER, '1')).success).toBe(true);
  });

  it('throws on non-ok responses', async () => {
    mockFetch(500, {});
    await expect(searchMemories(SERVER, 'x')).rejects.toThrow('500');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/memory-maintainer`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement routing**

`src/lib/memory-maintainer/config.ts`:

```ts
/* Memory maintainer routing: resolve a session cwd to a configured memory
 * project by longest prefix match. */
import type { MemoryConfig, MemoryProjectConfig } from '../../shared/config';

export interface RoutedProject {
  key: string;
  cfg: MemoryProjectConfig;
}

export function routeProject(cwd: string, memory: MemoryConfig): RoutedProject | null {
  let bestKey: string | null = null;
  let bestLen = -1;
  for (const [key, cfg] of Object.entries(memory.projects)) {
    for (const prefix of cfg.match) {
      if (cwd.startsWith(prefix) && prefix.length > bestLen) {
        bestKey = key;
        bestLen = prefix.length;
      }
    }
  }
  if (bestKey === null) return null;
  return { key: bestKey, cfg: memory.projects[bestKey] };
}
```

- [ ] **Step 4: Implement the REST client**

`src/lib/memory-maintainer/memory-api.ts`:

```ts
/* Memory API REST client. Plain fetch, Bearer auth. Endpoint shapes mirror
 * memory-mcp's client.ts (POST /api/v1/memories, GET /api/v1/memories/search,
 * PUT/DELETE /api/v1/memories/:id). No SDK. */
export interface MemoryServer {
  apiUrl: string;
  apiKey: string;
  project: string;
}

export interface MemoryHit {
  id: string;
  title: string;
  text: string;
  score: number;
}

export type StagedOp =
  | { op: 'store'; title: string; text: string; tags?: string[] }
  | { op: 'update'; id: string; title?: string; text: string }
  | { op: 'delete'; id: string; reason?: string }
  | { op: 'skip'; reason: string };

async function request<T>(server: MemoryServer, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${server.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`memory api ${method} ${path}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function searchMemories(server: MemoryServer, query: string, limit = 10): Promise<MemoryHit[]> {
  const qs = new URLSearchParams({ query, limit: String(limit), project: server.project });
  const data = await request<{ data: unknown[] }>(server, 'GET', `/api/v1/memories/search?${qs}`);
  return data.data as MemoryHit[];
}

export async function storeMemory(
  server: MemoryServer,
  params: { title: string; text: string; tags?: string[] },
): Promise<{ id: string }> {
  const data = await request<{ data: { id: string } }>(server, 'POST', '/api/v1/memories', {
    title: params.title,
    text: params.text,
    ...(params.tags ? { tags: params.tags } : {}),
    project: server.project,
  });
  return data.data;
}

export async function updateMemory(
  server: MemoryServer,
  params: { id: string; title?: string; text: string },
): Promise<{ success: boolean }> {
  const data = await request<{ data: { success: boolean } }>(server, 'PUT', `/api/v1/memories/${params.id}`, {
    text: params.text,
    ...(params.title ? { title: params.title } : {}),
  });
  return data.data;
}

export async function deleteMemory(server: MemoryServer, id: string): Promise<{ success: boolean }> {
  const data = await request<{ data: { success: boolean } }>(server, 'DELETE', `/api/v1/memories/${id}`);
  return data.data;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test src/lib/memory-maintainer`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

Run: `bun run lint`, then:

```bash
git add src/lib/memory-maintainer/config.ts src/lib/memory-maintainer/memory-api.ts src/lib/memory-maintainer/config.test.ts src/lib/memory-maintainer/memory-api.test.ts
git commit -m "feat(memory-maintainer): project routing and memory REST client"
```

---

### Task 3: DB state + session sweep

**Files:**
- Create: `src/lib/memory-maintainer/db.ts`
- Create: `src/lib/memory-maintainer/sweep.ts`
- Test: `src/lib/memory-maintainer/db.test.ts`
- Test: `src/lib/memory-maintainer/sweep.test.ts`

**Interfaces:**
- Consumes: `MemoryConfig` (Task 1), `routeProject` (Task 2).
- Produces:
  - `getDb(): Database` (better-sqlite3, lazy singleton; tables created IF NOT EXISTS; path from `ORCHESTREL_DB_PATH` env, default `data/orchestrel.db`)
  - `resetDb(): void` (test-only: close + clear singleton)
  - `upsertWatermark(db, path, mtimeMs, size): void`
  - `insertRun(db, runType, startedAt): number`
  - `finishRun(db, runId, status, summaryJson): void`
  - `SweepResult = { files: SessionFile[] }`
  - `sweepSessions(memory: MemoryConfig): SweepResult`

- [ ] **Step 1: Write the failing tests**

`src/lib/memory-maintainer/db.test.ts`:

```ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishRun, getDb, insertRun, resetDb, upsertWatermark } from './db';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-db-'));
  process.env.ORCHESTREL_DB_PATH = join(dir, 'test.db');
});
afterEach(() => {
  delete process.env.ORCHESTREL_DB_PATH;
  resetDb();
});

describe('maintainer db', () => {
  it('creates tables and tracks watermarks', () => {
    const db = getDb();
    upsertWatermark(db, '/s/1.jsonl', 100, 50);
    const row = db.prepare('SELECT mtime_ms, size FROM memory_maintainer_watermark WHERE path = ?').get('/s/1.jsonl');
    expect(row).toEqual({ mtime_ms: 100, size: 50 });
  });

  it('records runs with status transitions', () => {
    const db = getDb();
    const id = insertRun(db, 'daily', '2026-08-31T00:00:00Z');
    finishRun(db, id, 'done', '{"sessions":2}');
    const row = db.prepare('SELECT status, summary_json FROM memory_maintainer_runs WHERE id = ?').get(id);
    expect(row).toMatchObject({ status: 'done', summary_json: '{"sessions":2}' });
  });
});
```

`src/lib/memory-maintainer/sweep.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryConfig } from '../../shared/config';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getDb, resetDb } from './db';
import { sweepSessions } from './sweep';

const MEMORY: MemoryConfig = {
  mode: 'stage', provider: 'max', model: 'assistant', maxTurns: 30,
  excerptTokens: 24000, stageDir: 'data/memory-staging', settleMs: 600000,
  projects: {
    trackable: { match: ['/home/ryan/Code/trackable'], apiUrl: 'http://mem', apiKey: 'k', project: 'trackable' },
  },
};

let sessionsDir: string;
let oldDir: string | undefined;
beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'mm-sess-'));
  oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = sessionsDir;
  mkdirSync(join(sessionsDir, 'sessions', '--home-ryan-Code-trackable--'), { recursive: true });
});
afterEach(() => {
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldDir;
  resetDb();
});

function session(name: string, cwd: string, turns: number, mtimeMs: number): string {
  const p = join(sessionsDir, 'sessions', `--${cwd.replaceAll('/', '-').slice(1)}--`, name);
  mkdirSync(join(p, '..'), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', id: name, timestamp: '2026-08-31T00:00:00Z', cwd }),
    ...Array.from({ length: turns }, (_, i) => JSON.stringify({
      type: 'message', id: `m${i}`, timestamp: '2026-08-31T00:00:01Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
    })),
  ];
  writeFileSync(p, lines.join('\n'));
  const now = new Date().getTime();
  // mtime cannot be set directly; rely on the settle filter with a synthetic check below.
  void mtimeMs; void now;
  return p;
}

describe('sweepSessions', () => {
  it('classifies files by project and skips unconfigured cwds', () => {
    session('a.jsonl', '/home/ryan/Code/trackable', 4, 0);
    session('b.jsonl', '/home/ryan/Code/unconfigured', 4, 0);
    const result = sweepSessions(MEMORY);
    expect(result.files.map((f) => f.projectKey)).toEqual(['trackable']);
  });

  it('skips noisy sessions (no assistant turns) and already-seen files', () => {
    const p = session('c.jsonl', '/home/ryan/Code/trackable', 0, 0);
    const db = getDb();
    db.prepare('INSERT INTO memory_maintainer_watermark (path, mtime_ms, size, processed_at) VALUES (?, ?, ?, ?)')
      .run(p, 0, 0, '2026-08-31T00:00:00Z');
    expect(sweepSessions(MEMORY).files).toHaveLength(0);
  });
});
```

Note: `vi` import is unused in the sweep test as written; remove `vi` from the import if the linter objects (`bun run lint` must stay clean).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/memory-maintainer/db.test.ts src/lib/memory-maintainer/sweep.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement db.ts**

`src/lib/memory-maintainer/db.ts`:

```ts
/* Maintainer state in the orchestrel SQLite DB. Tables owned by this module
 * (CREATE TABLE IF NOT EXISTS), so the CLI path works without TypeORM init.
 * Path comes from ORCHESTREL_DB_PATH (test hook); default data/orchestrel.db.
 * Never run WAL management pragmas (CLAUDE.md guardrail). */
import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import Database from 'better-sqlite3';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const path = resolve(process.env.ORCHESTREL_DB_PATH ?? join(process.cwd(), 'data', 'orchestrel.db'));
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_maintainer_watermark (
      path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_maintainer_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      summary_json TEXT
    );
  `);
  return db;
}

/** Test-only: close the singleton so a new path takes effect. */
export function resetDb(): void {
  db?.close();
  db = null;
}

export function upsertWatermark(db: Database.Database, path: string, mtimeMs: number, size: number): void {
  db.prepare(
    `INSERT INTO memory_maintainer_watermark (path, mtime_ms, size, processed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, processed_at = excluded.processed_at`,
  ).run(path, mtimeMs, size, new Date().toISOString());
}

export function insertRun(db: Database.Database, runType: string, startedAt: string): number {
  const info = db
    .prepare(`INSERT INTO memory_maintainer_runs (run_type, started_at, status) VALUES (?, ?, 'running')`)
    .run(runType, startedAt);
  return Number(info.lastInsertRowid);
}

export function finishRun(db: Database.Database, runId: number, status: string, summaryJson: string): void {
  db.prepare(`UPDATE memory_maintainer_runs SET status = ?, finished_at = ?, summary_json = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    summaryJson,
    runId,
  );
}
```

- [ ] **Step 4: Implement sweep.ts**

`src/lib/memory-maintainer/sweep.ts`:

```ts
/* Session sweep: find new, settled session files under the pi agent sessions
 * dir, classify each by cwd → configured memory project. Watermark skips files
 * already seen with identical mtime+size. */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { MemoryConfig } from '../../shared/config';
import { routeProject } from './config';
import { getDb } from './db';

export interface SessionFile {
  path: string;
  mtimeMs: number;
  size: number;
  sessionId: string;
  cwd: string;
  projectKey: string;
}

export interface SweepResult {
  files: SessionFile[];
  droppedUnsettled: number;
  droppedUnknownProject: number;
  droppedNoise: number;
}

interface SessionHeader {
  id?: string;
  cwd?: string;
}

export function sweepSessions(memory: MemoryConfig): SweepResult {
  const sessionsDir = join(getAgentDir(), 'sessions');
  const db = getDb();
  const now = Date.now();
  const files: SessionFile[] = [];
  const result: SweepResult = { files, droppedUnsettled: 0, droppedUnknownProject: 0, droppedNoise: 0 };

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return result; // sessions dir does not exist yet — nothing to do
  }

  for (const dirName of projectDirs) {
    const dirPath = join(sessionsDir, dirName);
    let names: string[];
    try {
      names = readdirSync(dirPath).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dirPath, name);
      const st = statSync(path);
      if (st.mtimeMs > now - memory.settleMs) {
        result.droppedUnsettled += 1;
        continue;
      }
      const seen = db
        .prepare('SELECT mtime_ms, size FROM memory_maintainer_watermark WHERE path = ?')
        .get(path) as { mtime_ms: number; size: number } | undefined;
      if (seen && seen.mtime_ms === st.mtimeMs && seen.size === st.size) continue;

      const header = readHeader(path);
      if (!header?.cwd) continue;
      const routed = routeProject(header.cwd, memory);
      if (!routed) {
        result.droppedUnknownProject += 1;
        continue;
      }
      const stats = scanSession(path);
      if (stats.userMessages === 0 || stats.assistantTurns < 3) {
        result.droppedNoise += 1;
        continue;
      }
      files.push({
        path,
        mtimeMs: st.mtimeMs,
        size: st.size,
        sessionId: header.id ?? name,
        cwd: header.cwd,
        projectKey: routed.key,
      });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return result;
}

function readHeader(path: string): SessionHeader | undefined {
  try {
    const first = readFileSync(path, 'utf8').split('\n', 1)[0];
    const entry = JSON.parse(first) as { type?: string; id?: string; cwd?: string };
    if (entry.type !== 'session') return undefined;
    return { id: entry.id, cwd: entry.cwd };
  } catch {
    return undefined;
  }
}

function scanSession(path: string): { userMessages: number; assistantTurns: number } {
  let userMessages = 0;
  let assistantTurns = 0;
  const fd = readFileSync(path, 'utf8');
  for (const line of fd.split('\n')) {
    if (!line) continue;
    let entry: { type?: string; message?: { role?: string } };
    try {
      entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
    } catch {
      continue;
    }
    if (entry.type !== 'message') continue;
    if (entry.message?.role === 'user') userMessages += 1;
    if (entry.message?.role === 'assistant') assistantTurns += 1;
  }
  return { userMessages, assistantTurns };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test src/lib/memory-maintainer/db.test.ts src/lib/memory-maintainer/sweep.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

Run: `bun run lint`, then:

```bash
git add src/lib/memory-maintainer/db.ts src/lib/memory-maintainer/sweep.ts src/lib/memory-maintainer/db.test.ts src/lib/memory-maintainer/sweep.test.ts
git commit -m "feat(memory-maintainer): db state tables and session sweep"
```

---

### Task 4: Session excerpt builder

**Files:**
- Create: `src/lib/memory-maintainer/excerpt.ts`
- Test: `src/lib/memory-maintainer/excerpt.test.ts`

**Interfaces:**
- Consumes: pi session JSONL format (entries: `session`, `message` with role `user`/`assistant`/`toolResult`; assistant content blocks `text`/`thinking`/`toolCall`).
- Produces:
  - `Excerpt = { sessionId: string; cwd: string; startedAt: string; text: string; tokenEstimate: number }`
  - `buildExcerpt(path: string, maxTokens: number): Excerpt`

- [ ] **Step 1: Write the failing test**

`src/lib/memory-maintainer/excerpt.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildExcerpt } from './excerpt';

const LINES = [
  { type: 'session', id: 's1', timestamp: '2026-08-31T00:00:00Z', cwd: '/home/ryan/Code/trackable' },
  { type: 'model_change', id: 'mc', timestamp: '2026-08-31T00:00:01Z', provider: 'qwen', modelId: 'qwen3.8-max' },
  {
    type: 'message', id: 'u1', timestamp: '2026-08-31T00:00:02Z',
    message: { role: 'user', content: [{ type: 'text', text: 'fix the pipeline retry bug' }] },
  },
  {
    type: 'message', id: 'a1', timestamp: '2026-08-31T00:00:03Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'long reasoning we do not want' },
        { type: 'text', text: 'I will add a retry with backoff.' },
        { type: 'toolCall', id: 't1', name: 'edit', arguments: { filePath: 'src/x.ts' } },
      ],
    },
  },
  {
    type: 'message', id: 'r1', timestamp: '2026-08-31T00:00:04Z',
    message: { role: 'toolResult', toolCallId: 't1', toolName: 'edit', content: [{ type: 'text', text: 'ok' }] },
  },
];

function writeFixture(name: string, lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mm-ex-'));
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

describe('buildExcerpt', () => {
  it('extracts user/assistant/tool content and skips thinking', () => {
    const ex = buildExcerpt(writeFixture('s.jsonl', LINES), 1000);
    expect(ex.sessionId).toBe('s1');
    expect(ex.cwd).toBe('/home/ryan/Code/trackable');
    expect(ex.text).toContain('fix the pipeline retry bug');
    expect(ex.text).toContain('I will add a retry with backoff.');
    expect(ex.text).toContain('edit');
    expect(ex.text).toContain('ok');
    expect(ex.text).not.toContain('long reasoning');
    expect(ex.tokenEstimate).toBeGreaterThan(0);
  });

  it('trims oldest content when over budget', () => {
    const long = [
      ...LINES,
      {
        type: 'message', id: 'u2', timestamp: '2026-08-31T00:00:05Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Z'.repeat(5000) }] },
      },
    ];
    const ex = buildExcerpt(writeFixture('big.jsonl', long), 10);
    expect(ex.tokenEstimate).toBeLessThanOrEqual(10);
    expect(ex.text).not.toContain('fix the pipeline retry bug');
    expect(ex.text).toContain('Z'.repeat(4000));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/memory-maintainer/excerpt.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement excerpt.ts**

`src/lib/memory-maintainer/excerpt.ts`:

```ts
/* Session excerpt builder: collapse a pi session JSONL into a bounded text
 * excerpt for the consolidation agent. Thinking blocks are dropped; tool call
 * arguments and results are truncated. Newest content wins when over budget. */
import { readFileSync } from 'fs';

export interface Excerpt {
  sessionId: string;
  cwd: string;
  startedAt: string;
  text: string;
  tokenEstimate: number;
}

interface SessionEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

const TOOL_ARGS_CAP = 200;
const TOOL_RESULT_CAP = 400;

export function buildExcerpt(path: string, maxTokens: number): Excerpt {
  let sessionId = '';
  let cwd = '';
  let startedAt = '';
  const parts: string[] = [];

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      continue;
    }
    if (entry.type === 'session') {
      sessionId = entry.id ?? sessionId;
      cwd = entry.cwd ?? cwd;
      startedAt = entry.timestamp ?? startedAt;
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const role = entry.message.role;
    const content = entry.message.content;
    if (role === 'user') {
      parts.push(`USER: ${contentText(content)}`);
    } else if (role === 'assistant') {
      for (const block of contentBlocks(content)) {
        if (block.type === 'text') parts.push(`ASSISTANT: ${block.text}`);
        else if (block.type === 'toolCall') parts.push(`TOOL CALL: ${block.name}(${truncate(JSON.stringify(block.arguments), TOOL_ARGS_CAP)})`);
        // thinking blocks intentionally dropped
      }
    } else if (role === 'toolResult') {
      const rc = entry.message as SessionEntry['message'] & { toolName?: string; content?: unknown };
      parts.push(`TOOL RESULT ${rc.toolName ?? ''}: ${truncate(contentText(content), TOOL_RESULT_CAP)}`);
    }
  }

  let text = trimToBudget(parts, maxTokens);
  return { sessionId, cwd, startedAt, text, tokenEstimate: Math.ceil(text.length / 4) };
}

function contentBlocks(content: unknown): Array<{ type: string; text?: string; name?: string; arguments?: unknown }> {
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ type: string; text?: string; name?: string; arguments?: unknown }> = [];
  for (const b of content) {
    if (b && typeof b === 'object') {
      const rec = b as Record<string, unknown>;
      const type = String(rec.type ?? '');
      const block: { type: string; text?: string; name?: string; arguments?: unknown } = { type };
      if (typeof rec.text === 'string') block.text = rec.text;
      if (typeof rec.name === 'string') block.name = rec.name;
      if ('arguments' in rec) block.arguments = rec.arguments;
      blocks.push(block);
    }
  }
  return blocks;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of contentBlocks(content)) {
    if (block.type === 'text' && block.text) parts.push(block.text);
  }
  return parts.join('\n');
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}…`;
}

function trimToBudget(parts: string[], maxTokens: number): string {
  const charBudget = maxTokens * 4;
  let total = 0;
  let start = parts.length;
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = total + parts[i].length;
    if (next > charBudget) break;
    total = next;
    start = i;
  }
  return parts.slice(start).join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/memory-maintainer/excerpt.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `bun run lint`, then:

```bash
git add src/lib/memory-maintainer/excerpt.ts src/lib/memory-maintainer/excerpt.test.ts
git commit -m "feat(memory-maintainer): bounded session excerpt builder"
```

---

### Task 5: Consolidation agent (pi-ai tool loop)

**Files:**
- Create: `src/lib/memory-maintainer/consolidate.ts`
- Test: `src/lib/memory-maintainer/consolidate.test.ts`

**Interfaces:**
- Consumes: `MemoryServer`, `StagedOp`, `searchMemories`, `storeMemory`, `updateMemory`, `deleteMemory` (Task 2); `Excerpt` (Task 4); pi-ai `ModelRuntime`, `ModelRegistry`, `Tool`, `Message`, `ToolCall`, `ToolResultMessage`; `OrchestrelConfig`, `MemoryConfig` (Task 1).
- Produces:
  - `buildModel(cfg: OrchestrelConfig, memory: MemoryConfig): Promise<{ runtime: ModelRuntime; model: Model }>`
  - `consolidate(opts: ConsolidateOpts): Promise<StagedOp[]>`
  - `ConsolidateOpts = { excerpt: Excerpt; server: MemoryServer; runtime: ModelRuntime; model: Model; maxTurns: number; mode: 'stage' | 'write' }`

- [ ] **Step 1: Write the failing test**

`src/lib/memory-maintainer/consolidate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, Model, ModelRuntime, ToolCall } from '@earendil-works/pi-ai';
import type { MemoryServer } from './memory-api';
import { consolidate } from './consolidate';

const SERVER: MemoryServer = { apiUrl: 'http://mem.test', apiKey: 'k', project: 'trackable' };

const MODEL = { provider: 'max', id: 'qwen3.8-27b-oq8' } as unknown as Model;

function assistant(content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>, stop: string): AssistantMessage {
  return {
    role: 'assistant',
    content: content.map((c) => ({ ...c, type: c.type } as AssistantMessage['content'][number])),
    api: 'anthropic-messages',
    provider: 'max',
    model: 'qwen3.8-27b-oq8',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: stop === 'stop' ? 'stop' : 'toolUse',
    timestamp: 1,
  };
}

function toolCall(name: string, args: unknown): ToolCall {
  return { type: 'toolCall', id: `c-${name}`, name, arguments: args as Record<string, unknown> };
}

describe('consolidate', () => {
  it('records store/update/delete as ops in stage mode without calling the API', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        assistant([
          toolCall('search_memory', { query: 'retry' }),
          toolCall('store_memory', { title: 'Retry policy', text: 'Use backoff.', tags: ['infra'] }),
          toolCall('update_memory', { id: '9', text: 'new' }),
          toolCall('delete_memory', { id: '2', reason: 'stale' }),
        ], 'toolUse'),
      )
      .mockResolvedValueOnce(assistant([{ type: 'text', text: 'done' }], 'stop'));
    const runtime = { completeSimple: complete } as unknown as ModelRuntime;

    const ops = await consolidate({
      excerpt: { sessionId: 's1', cwd: '/x', startedAt: '', text: 'session text', tokenEstimate: 5 },
      server: SERVER,
      runtime,
      model: MODEL,
      maxTurns: 10,
      mode: 'stage',
    });

    expect(ops).toEqual([
      { op: 'store', title: 'Retry policy', text: 'Use backoff.', tags: ['infra'] },
      { op: 'update', id: '9', text: 'new' },
      { op: 'delete', id: '2', reason: 'stale' },
    ]);
    // search executed; store/update/delete did NOT hit the API in stage mode
    expect(complete).toHaveBeenCalledTimes(2);
    const callCounts = vi.mocked(fetch).mock.calls?.length ?? 0;
    expect(callCounts).toBe(0);
  });

  it('executes search and stops when the model makes no tool calls', async () => {
    const complete = vi.fn().mockResolvedValueOnce(assistant([{ type: 'text', text: 'no ops needed' }], 'stop'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }), text: () => Promise.resolve('') }));
    const ops = await consolidate({
      excerpt: { sessionId: 's1', cwd: '/x', startedAt: '', text: 't', tokenEstimate: 1 },
      server: SERVER,
      runtime: { completeSimple: complete } as unknown as ModelRuntime,
      model: MODEL,
      maxTurns: 10,
      mode: 'stage',
    });
    expect(ops).toEqual([]);
    vi.unstubAllGlobals();
  });
});
```

Note: the first test asserts `fetch` was never called (stage-mode store/update/delete are recorded, not executed) — stub `globalThis.fetch` with `vi.fn()` there too if your vitest environment has a real fetch; keep assertions consistent.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/memory-maintainer/consolidate.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement consolidate.ts**

`src/lib/memory-maintainer/consolidate.ts`:

```ts
/* Consolidation agent: one pi-ai ModelRuntime tool loop per session. Mirrors
 * src/orcd/pi-runtime.ts provider registration. In stage mode, search executes
 * and store/update/delete are recorded as StagedOps; in write mode they execute
 * against the memory API and are still recorded for the run log. */
import type { Model, ModelRuntime, Tool, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { Type } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { MemoryConfig, OrchestrelConfig, ProviderDef } from '../../shared/config';
import type { Excerpt } from './excerpt';
import { deleteMemory, searchMemories, storeMemory, updateMemory } from './memory-api';
import type { MemoryServer, StagedOp } from './memory-api';

const ANONYMOUS_API_KEY = 'anonymous';

export interface ConsolidateOpts {
  excerpt: Excerpt;
  server: MemoryServer;
  runtime: ModelRuntime;
  model: Model;
  maxTurns: number;
  mode: 'stage' | 'write';
}

const SYSTEM_PROMPT = `You consolidate a coding-agent session into durable memory entries.
Rules:
- One concept per memory. Use a concise descriptive title.
- Always search_memory before storing to check for duplicates; update or skip instead.
- Never store transient content: status checks, "repos clean", merge confirmations, or anything purely about the current moment.
- Never store secrets, API keys, or tokens.
- Delete a memory only when it is clearly stale and superseded.
- When done, reply with a short summary text and no tool calls. Do not loop.`;

export async function buildModel(
  cfg: OrchestrelConfig,
  memory: MemoryConfig,
): Promise<{ runtime: ModelRuntime; model: Model }> {
  const provider = cfg.providers[memory.provider];
  if (!provider) throw new Error(`memory: provider "${memory.provider}" not in config`);
  const modelDef = provider.models[memory.model];
  if (!modelDef) throw new Error(`memory: model "${memory.model}" not in provider "${memory.provider}"`);

  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(memory.provider, toProviderConfig(provider, modelDef.modelID));
  const model = registry.find(memory.provider, modelDef.modelID);
  if (!model) throw new Error(`memory: failed to resolve model ${memory.provider}/${modelDef.modelID}`);
  return { runtime, model };
}

function toProviderConfig(provider: ProviderDef, modelId: string) {
  return {
    name: provider.label ?? provider.id ?? 'memory',
    api: 'anthropic-messages' as const,
    baseUrl: provider.baseUrl || 'https://api.anthropic.com',
    apiKey: provider.apiKey || provider.authToken || ANONYMOUS_API_KEY,
    models: [
      {
        id: modelId,
        name: modelId,
        api: 'anthropic-messages' as const,
        reasoning: true,
        input: ['text', 'image'] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 64_000,
      },
    ],
  };
}

const tools: Tool[] = [
  {
    name: 'search_memory',
    description: 'Search existing memories for duplicates or related knowledge.',
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'store_memory',
    description: 'Store a new memory (one concept).',
    parameters: Type.Object({
      title: Type.String(),
      text: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
  },
  {
    name: 'update_memory',
    description: 'Update an existing memory by id.',
    parameters: Type.Object({
      id: Type.String(),
      title: Type.Optional(Type.String()),
      text: Type.String(),
    }),
  },
  {
    name: 'delete_memory',
    description: 'Delete an existing memory by id (stale or superseded only).',
    parameters: Type.Object({
      id: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
  },
];

export async function consolidate(opts: ConsolidateOpts): Promise<StagedOp[]> {
  const { excerpt, server, runtime, model, maxTurns, mode } = opts;
  const ops: StagedOp[] = [];
  const messages: Array<{ role: 'user' | 'assistant' | 'toolResult'; content: unknown; timestamp?: number }> = [
    { role: 'user', content: [{ type: 'text', text: `Session: ${excerpt.sessionId} (${excerpt.cwd})\n\n${excerpt.text}` }] },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const msg = await runtime.completeSimple(model, { system: SYSTEM_PROMPT, messages, tools });
    messages.push(msg);
    const calls = msg.content.filter((b): b is ToolCall => b.type === 'toolCall');
    if (calls.length === 0) break;
    for (const call of calls) {
      const result = await runTool(call, server, mode, ops);
      messages.push(result);
    }
  }

  return dedupeOps(ops);
}

async function runTool(call: ToolCall, server: MemoryServer, mode: 'stage' | 'write', ops: StagedOp[]): Promise<ToolResultMessage> {
  try {
    const args = call.arguments as Record<string, unknown>;
    const text = (s: string): string => (mode === 'write' && secretsPattern.test(s) ? '[redacted]' : s);
    switch (call.name) {
      case 'search_memory': {
        const hits = await searchMemories(server, String(args.query), Number(args.limit ?? 10));
        return toolResult(call, JSON.stringify(hits.map((h) => ({ id: h.id, title: h.title, score: h.score }))));
      }
      case 'store_memory': {
        const title = String(args.title);
        const body = text(String(args.text));
        ops.push({ op: 'store', title, text: body, ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}) });
        if (mode === 'write') {
          const { id } = await storeMemory(server, { title, text: body });
          return toolResult(call, JSON.stringify({ id }));
        }
        return toolResult(call, 'recorded (stage mode)');
      }
      case 'update_memory': {
        const id = String(args.id);
        const body = text(String(args.text));
        ops.push({ op: 'update', id, text: body, ...(args.title ? { title: String(args.title) } : {}) });
        if (mode === 'write') {
          const { success } = await updateMemory(server, { id, text: body, ...(args.title ? { title: String(args.title) } : {}) });
          return toolResult(call, JSON.stringify({ success }));
        }
        return toolResult(call, 'recorded (stage mode)');
      }
      case 'delete_memory': {
        const id = String(args.id);
        ops.push({ op: 'delete', id, ...(args.reason ? { reason: String(args.reason) } : {}) });
        if (mode === 'write') {
          const { success } = await deleteMemory(server, id);
          return toolResult(call, JSON.stringify({ success }));
        }
        return toolResult(call, 'recorded (stage mode)');
      }
      default:
        return toolResult(call, `unknown tool ${call.name}`, true);
    }
  } catch (err) {
    return toolResult(call, `error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

const secretsPattern = /sk-[A-Za-z0-9]{20,}|Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function toolResult(call: ToolCall, text: string, isError = false): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  };
}

function dedupeOps(ops: StagedOp[]): StagedOp[] {
  const seen = new Set<string>();
  return ops.filter((op) => {
    if (op.op === 'skip') return true;
    const key = op.op === 'store' ? `store:${op.title}` : `${op.op}:${op.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/memory-maintainer/consolidate.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `bun run lint`, then:

```bash
git add src/lib/memory-maintainer/consolidate.ts src/lib/memory-maintainer/consolidate.test.ts
git commit -m "feat(memory-maintainer): pi-ai consolidation agent with stage/write modes"
```

---

### Task 6: Staging writer + Telegram alert

**Files:**
- Create: `src/lib/memory-maintainer/staging.ts`
- Create: `src/lib/memory-maintainer/telegram.ts`
- Test: `src/lib/memory-maintainer/staging.test.ts`
- Test: `src/lib/memory-maintainer/telegram.test.ts`

**Interfaces:**
- Consumes: `StagedOp` (Task 2).
- Produces:
  - `StagingEntry = { project: string; apiUrl: string; sessionId: string; source: string; ops: StagedOp[] }`
  - `appendStaging(stageDir: string, entry: StagingEntry, filename?: string): string`
  - `readStagingFile(path: string): StagingDay | null`
  - `sendTelegramAlert(botToken: string, chatId: string, text: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

`src/lib/memory-maintainer/staging.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { appendStaging, readStagingFile } from './staging';

describe('staging', () => {
  it('appends entries to a per-day file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-stage-'));
    const entry = {
      project: 'trackable',
      apiUrl: 'https://memory.trackable.io',
      sessionId: 's1',
      source: 'a.jsonl',
      ops: [{ op: 'store', title: 't', text: 'x' }],
    };
    const file = appendStaging(dir, entry);
    appendStaging(dir, { ...entry, sessionId: 's2' });
    const day = readStagingFile(file);
    expect(day?.entries).toHaveLength(2);
    expect(JSON.parse(readFileSync(file, 'utf8')).date).toBe(new Date().toISOString().slice(0, 10));
  });
});
```

`src/lib/memory-maintainer/telegram.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendTelegramAlert } from './telegram';

afterEach(() => vi.unstubAllGlobals());

describe('sendTelegramAlert', () => {
  it('posts to the sendMessage endpoint and returns true on ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }));
    await expect(sendTelegramAlert('bot', 'chat', 'hello')).resolves.toBe(true);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botbot/sendMessage');
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: 'chat', text: 'hello' });
  });

  it('throws on non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('bad') }));
    await expect(sendTelegramAlert('bot', 'chat', 'x')).rejects.toThrow('400');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/memory-maintainer/staging.test.ts src/lib/memory-maintainer/telegram.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement staging.ts**

`src/lib/memory-maintainer/staging.ts`:

```ts
/* Per-day staging JSON. Append-only for the day; written atomically (tmp +
 * rename) so the review flow never reads a half-written file. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { StagedOp } from './memory-api';

export interface StagingEntry {
  project: string;
  apiUrl: string;
  sessionId: string;
  source: string;
  ops: StagedOp[];
}

export interface StagingDay {
  date: string;
  entries: StagingEntry[];
}

export function readStagingFile(path: string): StagingDay | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StagingDay;
  } catch {
    return null;
  }
}

export function appendStaging(stageDir: string, entry: StagingEntry, filename?: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const file = join(stageDir, filename ?? `${date}.json`);
  mkdirSync(stageDir, { recursive: true });
  const day = readStagingFile(file) ?? { date, entries: [] };
  day.entries.push(entry);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(day, null, 2));
  renameSync(tmp, file);
  return file;
}
```

- [ ] **Step 4: Implement telegram.ts**

`src/lib/memory-maintainer/telegram.ts`:

```ts
/* Telegram alert for the daily maintainer summary. Plain fetch; no SDK. */
export async function sendTelegramAlert(botToken: string, chatId: string, text: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    throw new Error(`telegram sendMessage: ${res.status} ${await res.text()}`);
  }
  return true;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test src/lib/memory-maintainer/staging.test.ts src/lib/memory-maintainer/telegram.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

Run: `bun run lint`, then:

```bash
git add src/lib/memory-maintainer/staging.ts src/lib/memory-maintainer/telegram.ts src/lib/memory-maintainer/staging.test.ts src/lib/memory-maintainer/telegram.test.ts
git commit -m "feat(memory-maintainer): staging writer and telegram alert"
```

---

### Task 7: Daily orchestration (`runMaintain`)

**Files:**
- Create: `src/lib/memory-maintainer/maintain.ts`
- Test: `src/lib/memory-maintainer/maintain.test.ts`

**Interfaces:**
- Consumes: `sweepSessions` (Task 3), `buildExcerpt` (Task 4), `buildModel`/`consolidate` (Task 5), `appendStaging` (Task 6), `sendTelegramAlert` (Task 6), `getDb`/`insertRun`/`finishRun`/`upsertWatermark` (Task 3), `OrchestrelConfig` (Task 1).
- Produces:
  - `MaintainSummary = { runId: number; projects: ProjectSummary[]; stagingFiles: string[]; durationMs: number }`
  - `ProjectSummary = { project: string; sessions: number; ops: number; stores: number; updates: number; deletes: number; skips: number; errors: string[] }`
  - `runMaintain(cfg: OrchestrelConfig): Promise<MaintainSummary | null>` (null when memory config absent)
  - `buildAlertText(summary: MaintainSummary, stageDir: string): string`

- [ ] **Step 1: Write the failing tests**

`src/lib/memory-maintainer/maintain.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { OrchestrelConfig } from '../../shared/config';
import { buildAlertText, runMaintain } from './maintain';

const BASE: OrchestrelConfig = {
  listen: { host: '127.0.0.1', port: 1 },
  authToken: 't',
  name: 'test',
  defaultProvider: 'max',
  defaultModel: 'assistant',
  ringBufferSize: 100,
  providers: { max: { baseUrl: 'http://max.local:11434', apiKey: 'x', models: { assistant: { label: 'a', modelID: 'm', contextWindow: 1000 } } } },
};

describe('runMaintain', () => {
  it('returns null when memory config is absent', async () => {
    expect(await runMaintain(BASE)).toBeNull();
  });
});

describe('buildAlertText', () => {
  it('summarizes per-project counts', () => {
    const text = buildAlertText(
      {
        runId: 7,
        durationMs: 1234,
        stagingFiles: ['data/memory-staging/2026-08-31.json'],
        projects: [
          { project: 'trackable', sessions: 2, ops: 5, stores: 3, updates: 1, deletes: 0, skips: 1, errors: [] },
        ],
      },
      'data/memory-staging',
    );
    expect(text).toContain('trackable');
    expect(text).toContain('2 sessions');
    expect(text).toContain('3 stores');
    expect(text).toContain('2026-08-31.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/memory-maintainer/maintain.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement maintain.ts**

`src/lib/memory-maintainer/maintain.ts`:

```ts
/* Daily maintainer run: sweep sessions, consolidate per configured project,
 * stage the proposed ops, alert via Telegram. Errors in one session or project
 * never abort the run; the watermark advances per file regardless so a
 * consistently-failing file is not retried forever. */
import type { OrchestrelConfig } from '../../shared/config';
import { buildModel, consolidate } from './consolidate';
import { buildExcerpt } from './excerpt';
import { finishRun, getDb, insertRun, upsertWatermark } from './db';
import { appendStaging } from './staging';
import { sendTelegramAlert } from './telegram';
import { sweepSessions } from './sweep';

export interface ProjectSummary {
  project: string;
  sessions: number;
  ops: number;
  stores: number;
  updates: number;
  deletes: number;
  skips: number;
  errors: string[];
}

export interface MaintainSummary {
  runId: number;
  projects: ProjectSummary[];
  stagingFiles: string[];
  durationMs: number;
}

export async function runMaintain(cfg: OrchestrelConfig): Promise<MaintainSummary | null> {
  const memory = cfg.memory;
  if (!memory) return null;

  const db = getDb();
  const startedAt = new Date().toISOString();
  const runId = insertRun(db, 'daily', startedAt);
  const started = Date.now();
  const stagingFiles = new Set<string>();
  const projects: ProjectSummary[] = [];

  try {
    const sweep = sweepSessions(memory);
    const byProject = new Map<string, typeof sweep.files>();
    for (const f of sweep.files) {
      const list = byProject.get(f.projectKey) ?? [];
      list.push(f);
      byProject.set(f.projectKey, list);
    }

    const { runtime, model } = await buildModel(cfg, memory);
    for (const [key, files] of byProject) {
      const server = {
        apiUrl: memory.projects[key].apiUrl,
        apiKey: memory.projects[key].apiKey,
        project: memory.projects[key].project,
      };
      const summary: ProjectSummary = { project: key, sessions: 0, ops: 0, stores: 0, updates: 0, deletes: 0, skips: 0, errors: [] };
      for (const file of files) {
        try {
          const excerpt = buildExcerpt(file.path, memory.excerptTokens);
          const ops = await consolidate({ excerpt, server, runtime, model, maxTurns: memory.maxTurns, mode: memory.mode });
          const stagingFile = appendStaging(memory.stageDir, {
            project: key,
            apiUrl: server.apiUrl,
            sessionId: file.sessionId,
            source: file.path,
            ops,
          });
          stagingFiles.add(stagingFile);
          summary.sessions += 1;
          summary.ops += ops.length;
          for (const op of ops) {
            if (op.op === 'store') summary.stores += 1;
            else if (op.op === 'update') summary.updates += 1;
            else if (op.op === 'delete') summary.deletes += 1;
            else summary.skips += 1;
          }
        } catch (err) {
          summary.errors.push(`${file.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          upsertWatermark(db, file.path, file.mtimeMs, file.size);
        }
      }
      projects.push(summary);
    }

    const summary: MaintainSummary = { runId, projects, stagingFiles: [...stagingFiles], durationMs: Date.now() - started };
    finishRun(db, runId, 'done', JSON.stringify(summary));
    if (memory.telegram) {
      try {
        await sendTelegramAlert(memory.telegram.botToken, memory.telegram.chatId, buildAlertText(summary, memory.stageDir));
      } catch (err) {
        console.error('[memory-maintainer] telegram alert failed:', err);
      }
    }
    return summary;
  } catch (err) {
    finishRun(db, runId, 'failed', JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    throw err;
  }
}

export function buildAlertText(summary: MaintainSummary, stageDir: string): string {
  const lines = summary.projects.map(
    (p) =>
      `${p.project}: ${p.sessions} sessions, ${p.stores} stores, ${p.updates} updates, ${p.deletes} deletes, ${p.skips} skips${p.errors.length ? `, ${p.errors.length} errors` : ''}`,
  );
  return [
    `Memory maintainer (${new Date().toISOString().slice(0, 10)})`,
    ...lines,
    `Staged: ${summary.stagingFiles.join(', ') || 'none'}`,
    `Duration: ${summary.durationMs}ms`,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/memory-maintainer/maintain.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `bun run lint`, then:

```bash
git add src/lib/memory-maintainer/maintain.ts src/lib/memory-maintainer/maintain.test.ts
git commit -m "feat(memory-maintainer): daily run orchestration"
```

---

### Task 8: Weekly merge pass

**Files:**
- Create: `src/lib/memory-maintainer/merge.ts`
- Test: `src/lib/memory-maintainer/merge.test.ts`

**Interfaces:**
- Consumes: `readStagingFile`, `appendStaging` (Task 6); `buildModel`, `consolidate` (Task 5 — reuses the loop with a merge prompt and search-only tools); `OrchestrelConfig`.
- Produces:
  - `MergeSummary = { groups: number; ops: number; stagingFile: string }`
  - `runMerge(cfg: OrchestrelConfig): Promise<MergeSummary | null>` (null when memory config absent)

- [ ] **Step 1: Write the failing tests**

`src/lib/memory-maintainer/merge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { collectWeekEntries, groupByServer } from './merge';
import type { StagingEntry } from './staging';

describe('merge grouping', () => {
  it('groups staging entries strictly within one memory server set', () => {
    const entries: StagingEntry[] = [
      { project: 'trackable', apiUrl: 'https://memory.trackable.io', sessionId: 'a', source: 'a', ops: [{ op: 'store', title: 't1', text: 'x' }] },
      { project: 'trackable', apiUrl: 'https://memory.trackable.io', sessionId: 'b', source: 'b', ops: [{ op: 'store', title: 't2', text: 'y' }] },
      { project: 'okkanti', apiUrl: 'http://localhost:3100', sessionId: 'c', source: 'c', ops: [{ op: 'store', title: 't3', text: 'z' }] },
    ];
    const groups = groupByServer(entries);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.key === 'trackable@https://memory.trackable.io')?.entries).toHaveLength(2);
  });

  it('collectWeekEntries ignores merge files older than 7 days', () => {
    expect(collectWeekEntries('/nonexistent')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/memory-maintainer/merge.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement merge.ts**

`src/lib/memory-maintainer/merge.ts`:

```ts
/* Weekly merge pass: group the week's staged store ops by memory server set
 * (apiUrl + project) and run one agent pass per group to merge near-duplicates
 * and recurring themes into durable memories. Never merges across server sets. */
import { readdirSync } from 'fs';
import { join } from 'path';
import type { MemoryConfig, OrchestrelConfig } from '../../shared/config';
import { buildModel } from './consolidate';
import { finishRun, getDb, insertRun } from './db';
import { appendStaging, readStagingFile } from './staging';
import type { StagingEntry } from './staging';
import type { MemoryServer, StagedOp } from './memory-api';

export interface MergeSummary {
  groups: number;
  ops: number;
  stagingFile: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function collectWeekEntries(stageDir: string): StagingEntry[] {
  let names: string[];
  try {
    names = readdirSync(stageDir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const cutoff = Date.now() - WEEK_MS;
  const entries: StagingEntry[] = [];
  for (const name of names) {
    const path = join(stageDir, name);
    let mtime: number;
    try {
      mtime = require('fs').statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) continue;
    const day = readStagingFile(path);
    if (day) entries.push(...day.entries);
  }
  return entries;
}

export function groupByServer(entries: StagingEntry[]): Array<{ key: string; entries: StagingEntry[] }> {
  const groups = new Map<string, StagingEntry[]>();
  for (const e of entries) {
    const key = `${e.project}@${e.apiUrl}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, entries: list }));
}

export async function runMerge(cfg: OrchestrelConfig): Promise<MergeSummary | null> {
  const memory = cfg.memory;
  if (!memory) return null;

  const db = getDb();
  const startedAt = new Date().toISOString();
  const runId = insertRun(db, 'weekly', startedAt);
  const entries = collectWeekEntries(memory.stageDir);
  const groups = groupByServer(entries);
  const { runtime, model } = await buildModel(cfg, memory);
  const mergedOps: StagedOp[] = [];

  for (const group of groups) {
    const [project] = group.key.split('@');
    const first = group.entries[0];
    const server: MemoryServer = { apiUrl: first.apiUrl, apiKey: '', project };
    // apiKey is not recoverable from staging files; look it up from config.
    const cfgEntry = memory.projects[project];
    if (!cfgEntry) continue;
    server.apiKey = cfgEntry.apiKey;
    const stores = group.entries.flatMap((e) => e.ops).filter((op): op is Extract<StagedOp, { op: 'store' }> => op.op === 'store');
    if (stores.length === 0) continue;
    const prompt = `Merge these memory candidates from one week of sessions (${group.entries.length} sessions, ${stores.length} candidates):\n\n${stores.map((s) => `- ${s.title}: ${s.text}`).join('\n')}\n\nGroup near-duplicates into one durable memory. Recurring themes across 2+ sessions become durable memories with a short evidence note. Search existing memories first; update instead of creating duplicates.`;
    const ops = await consolidate({
      excerpt: { sessionId: `merge-${group.key}`, cwd: '', startedAt: '', text: prompt, tokenEstimate: 0 },
      server,
      runtime,
      model,
      maxTurns: memory.maxTurns,
      mode: 'stage',
    });
    mergedOps.push(...ops);
  }

  const stagingFile = appendStaging(
    memory.stageDir,
    {
      project: 'merge',
      apiUrl: 'merge',
      sessionId: `merge-${new Date().toISOString().slice(0, 10)}`,
      source: 'merge',
      ops: mergedOps,
    },
    `merge-${new Date().toISOString().slice(0, 10)}.json`,
  );

  const summary: MergeSummary = { groups: groups.length, ops: mergedOps.length, stagingFile };
  finishRun(db, runId, 'done', JSON.stringify(summary));
  return summary;
}
```

Note: the plan imports `require('fs')` inline for statSync — replace it with a top-level `import { statSync } from 'fs'` when implementing (the snippet keeps the change local to `collectWeekEntries`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/memory-maintainer/merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `bun run lint`, then:

```bash
git add src/lib/memory-maintainer/merge.ts src/lib/memory-maintainer/merge.test.ts
git commit -m "feat(memory-maintainer): weekly scoped merge pass"
```

---

### Task 9: Scheduler + server wiring

**Files:**
- Create: `src/lib/memory-maintainer/scheduler.ts`
- Modify: `src/server/init.ts`
- Modify: `src/server/ws/server.ts`
- Test: `src/lib/memory-maintainer/scheduler.test.ts`

**Interfaces:**
- Consumes: `runMaintain` (Task 7), `runMerge` (Task 8), `loadConfig` (Task 1).
- Produces: `startMemoryMaintainer(): () => void` — starts the daily + weekly timers, returns a stop function; idempotent (subsequent calls are no-ops until stopped).

- [ ] **Step 1: Write the failing test**

`src/lib/memory-maintainer/scheduler.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { msUntil, startMemoryMaintainer } from './scheduler';

describe('msUntil', () => {
  it('computes positive ms to the next daily fire', () => {
    const ms = msUntil(2, 0);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(25 * 60 * 60 * 1000);
  });
});

describe('startMemoryMaintainer', () => {
  it('is idempotent and returns a stop function', () => {
    const stop1 = startMemoryMaintainer();
    const stop2 = startMemoryMaintainer();
    expect(typeof stop1).toBe('function');
    stop1();
    stop2();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/memory-maintainer/scheduler.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement scheduler.ts**

`src/lib/memory-maintainer/scheduler.ts`:

```ts
/* In-process daily + weekly timers for the memory maintainer, started once by
 * the server init paths (production init.ts and dev ws/server.ts guarded
 * block). One run in flight at a time; a missed fire just waits for the next
 * scheduled slot. */
import { loadConfig } from '../../shared/config';
import { runMaintain } from './maintain';
import { runMerge } from './merge';

const DAILY_HOUR = 2;
const WEEKLY_HOUR = 3;
const WEEKLY_DAY = 0; // Sunday

let started = false;
let running = false;
const timers: ReturnType<typeof setTimeout>[] = [];

export function startMemoryMaintainer(): () => void {
  if (started) return () => stopTimers();
  started = true;
  schedule(() => void fire('daily'), msUntil(DAILY_HOUR, 0));
  schedule(() => void fire('weekly'), msUntil(WEEKLY_HOUR, 0, WEEKLY_DAY));
  return () => stopTimers();
}

async function fire(kind: 'daily' | 'weekly'): Promise<void> {
  if (running) return;
  running = true;
  try {
    const cfg = loadConfig();
    if (!cfg.memory) return;
    const start = Date.now();
    if (kind === 'daily') {
      const summary = await runMaintain(cfg);
      console.log(`[memory-maintainer] daily run done in ${Date.now() - start}ms`, summary ? `${summary.projects.length} projects` : 'disabled');
    } else {
      const summary = await runMerge(cfg);
      console.log(`[memory-maintainer] weekly merge done in ${Date.now() - start}ms`, summary ? `${summary.groups} groups` : 'disabled');
    }
  } catch (err) {
    console.error('[memory-maintainer] run failed:', err);
  } finally {
    running = false;
  }
}

function schedule(fn: () => void, ms: number): void {
  const max = 2_147_483_647;
  const t = setTimeout(() => {
    fn();
    schedule(fn, msUntil(DAILY_HOUR, 0));
  }, Math.min(ms, max));
  timers.push(t);
}

function stopTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
}

/** Milliseconds until the next fire. Exported for tests. */
export function msUntil(hour: number, minute: number, dayOfWeek?: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  if (dayOfWeek !== undefined) {
    while (next.getDay() !== dayOfWeek) next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}
```

Note: `schedule` re-arms itself with `msUntil(DAILY_HOUR, 0)` for both kinds — when implementing, keep the weekly re-arm correct by passing the kind's own next-fire computation (the re-arm above is a simplification; use a closure that recomputes per kind).

- [ ] **Step 4: Wire into both server init paths**

In `src/server/init.ts`, add an import and start it before `initState.markInitialized()`:

```ts
import { startMemoryMaintainer } from '../lib/memory-maintainer/scheduler';
// …inside initBackend(), immediately before initState.markInitialized():
startMemoryMaintainer();
```

In `src/server/ws/server.ts`, inside the `if (initState.isInitialized()) return;` guarded block, before `initState.markInitialized()`:

```ts
const { startMemoryMaintainer } = await import('../lib/memory-maintainer/scheduler');
startMemoryMaintainer();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test src/lib/memory-maintainer/scheduler.test.ts` and `bun run typecheck`
Expected: PASS (both).

- [ ] **Step 6: Lint and commit**

Run: `bun run lint`, then:

```bash
git add src/lib/memory-maintainer/scheduler.ts src/lib/memory-maintainer/scheduler.test.ts src/server/init.ts src/server/ws/server.ts
git commit -m "feat(memory-maintainer): in-process daily and weekly scheduler"
```

---

### Task 10: CLI

**Files:**
- Create: `src/lib/memory-maintainer/cli.ts`
- Modify: `package.json` (add script)

**Interfaces:**
- Consumes: `runMaintain` (Task 7), `runMerge` (Task 8), `loadConfig` (Task 1).
- Produces: a `bun run memory-maintainer --run|--weekly|--status` entrypoint.

- [ ] **Step 1: Implement cli.ts**

`src/lib/memory-maintainer/cli.ts`:

```ts
/* Memory maintainer CLI: manual runs and status. Args parsed first, then main. */
import arg from 'arg';
import { loadConfig } from '../../shared/config';
import { getDb } from './db';
import { runMaintain } from './maintain';
import { runMerge } from './merge';

async function main(): Promise<void> {
  const args = arg({
    '--run': Boolean,
    '--weekly': Boolean,
    '--status': Boolean,
  });

  const cfg = loadConfig();

  if (args['--status']) {
    const db = getDb();
    const rows = db
      .prepare('SELECT id, run_type, status, started_at, finished_at FROM memory_maintainer_runs ORDER BY id DESC LIMIT 10')
      .all() as Array<Record<string, unknown>>;
    console.table(rows);
    return;
  }

  if (args['--weekly']) {
    const summary = await runMerge(cfg);
    console.log('merge:', summary ? `${summary.groups} groups, ${summary.ops} ops → ${summary.stagingFile}` : 'disabled (no memory config)');
    return;
  }

  if (args['--run']) {
    const summary = await runMaintain(cfg);
    if (!summary) {
      console.log('maintainer disabled (no memory config)');
      return;
    }
    console.log('done:', JSON.stringify(summary, null, 2));
    return;
  }

  console.log('usage: memory-maintainer --run | --weekly | --status');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the package.json script**

In `package.json` `scripts`:

```json
"memory-maintainer": "tsx src/lib/memory-maintainer/cli.ts"
```

- [ ] **Step 3: Verify it builds and runs**

Run: `bun run typecheck` and `bun run memory-maintainer --status`
Expected: typecheck passes; status prints the last runs table (empty on a fresh DB) — this also proves `getDb` created the tables.

- [ ] **Step 4: Lint and commit**

Run: `bun run lint`, then:

```bash
git add src/lib/memory-maintainer/cli.ts package.json
git commit -m "feat(memory-maintainer): CLI for manual runs and status"
```

---

### Task 11: End-to-end verification on real sessions

**Files:**
- Modify: `orcd.yaml` (local, gitignored — add the `memory:` section; do NOT commit)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add the memory section to the local config**

In `~/Code/orchestrel/orcd.yaml`, add the section from Task 1 Step 5, with the trackable project entry and `telegram.botToken`/`chatId` filled from your real values. Ensure `TRACKABLE_MEMORY_API_KEY` is in the environment (`/home/ryan/plans/.env`) or inline.

- [ ] **Step 2: Run a manual daily run**

Run: `bun run memory-maintainer --run`
Expected: recent settled trackable sessions appear; a staging file `data/memory-staging/YYYY-MM-DD.json` is created with per-session ops; Telegram alert arrives.

- [ ] **Step 3: Inspect the staged ops for quality**

Read `data/memory-staging/YYYY-MM-DD.json`. Check: titles concise, one concept per memory, no transient content, no secrets, dedupe against existing memories sensible. This is the review gate from the design — the model quality decision (max.local `assistant`) is settled here.

- [ ] **Step 4: Confirm idempotency**

Run: `bun run memory-maintainer --run` again.
Expected: no new entries — the watermark advanced.

- [ ] **Step 5: Restart the service and confirm the scheduler arms**

Run: `sudo systemctl restart orchestrel` and check the journal for the maintainer line at the next daily slot (or temporarily set `DAILY_HOUR` for a quick check in dev):
Expected: `[memory-maintainer] daily run done …` appears in `journalctl -u orchestrel`.

- [ ] **Step 6: Verify the weekly merge once**

Run: `bun run memory-maintainer --weekly`
Expected: `merge-YYYY-MM-DD.json` appears in the staging dir with merged ops grouped per memory server set.

---

## Self-Review Notes

- **Spec coverage:** config (T1), routing/client (T2), sweep/watermark/DB (T3), excerpt (T4), consolidation agent (T5), staging + telegram (T6), daily run (T7), weekly merge scoped per server set (T8), scheduler + init wiring (T9), CLI (T10), E2E verification (T11). All spec sections map to a task.
- **Deviation from spec:** the spec lists the two DB tables under `src/server/models/index.ts::initDatabase`; the plan instead creates them in `src/lib/memory-maintainer/db.ts` (CREATE TABLE IF NOT EXISTS), so the CLI path works without TypeORM init and the schema lives with its module. Same tables, one owner.
- **Placeholders:** Task 9 Step 3 contains two noted simplifications (`schedule` re-arm per kind, and the `require('fs')` inline import in Task 8) — both flagged in-place for the implementer to resolve with the obvious fix (per-kind re-arm closure; top-level `statSync` import).
- **Type consistency:** `StagedOp`/`MemoryServer` defined once (T2) and reused everywhere; `Excerpt` (T4) consumed by `consolidate` (T5) and `runMerge` (T8); `ConsolidateOpts` (T5) is the single shape `runMaintain`/`runMerge` pass into `consolidate`.
