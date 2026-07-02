# Multi-orcd: Remote Execution Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the central Orc backend drive multiple orcd daemons over authenticated TCP so agents run on the box that physically holds each project's files, while orchestration state stays central.

**Architecture:** orcd switches from a unix socket to an authenticated TCP listener and takes ownership of all node-local filesystem work (worktree create/remove, setup commands, path validation). The BE replaces its single `OrcdClient` + local-file provider config with a map of per-node `OrcdClient`s keyed by node name, each caching capabilities reported over the protocol. Cards/projects carry an immutable `node_name` that routes every action to the right node.

**Tech Stack:** TypeScript (strict), Node `net` (newline-delimited JSON framing), TypeORM + SQLite, Vitest, MobX (FE), Socket.IO, React.

**Spec:** `docs/specs/2026-06-29-multi-orcd-remote-execution-nodes-design.md`

---

## Reference: key files and current responsibilities

- `src/shared/orcd-protocol.ts` — action/message type unions for the orcd wire protocol.
- `src/shared/config.ts` — shared YAML loader (`loadConfig`, `parseConfig`, `resolveEnvVars`); currently read by BOTH orcd and BE.
- `src/orcd/config.ts` — orcd-shaped config (`loadOrcdConfig`, `parseConfig`); wraps shared loader.
- `src/orcd/socket-server.ts` — `OrcdServer`: unix socket listen, connection handling, action dispatch, session lifecycle, `buildProviderEnv`.
- `src/orcd/index.ts` — orcd entrypoint; resolves socket path, constructs `OrcdServer`.
- `src/server/orcd-client.ts` — BE's `OrcdClient`: dials unix socket, create/list correlation, reconnect.
- `src/server/init-state.ts` — survives Vite restarts; holds single `OrcdClient` via `getOrcdClient`/`setOrcdClient`.
- `src/server/ws/server.ts` (~L145-180) — one-time init: constructs `OrcdClient`, connects, wires router + listeners.
- `src/server/config/providers.ts` — BE provider catalog from local config (`getProvidersForClient`, `getModelConfig`, `getDefaultModel`, `getDefaultProviderID`). **To be deleted.**
- `src/server/worktree.ts` — BE-local git/setup execution (`createWorktree`, `removeWorktree`, `runSetupCommands`, `worktreeExists`, `copyOpencodeConfig`). **Moves to orcd.**
- `src/server/sessions/worktree.ts` — `ensureWorktree(card)`: creation path. → `worktree_prepare`.
- `src/server/controllers/card-sessions.ts` — orcd message router, reconciliation, auto-start, worktree cleanup (~L365), `startCardSession`.
- `src/server/services/card.ts` — `createCard` (uses `getModelConfig`/`getDefaultProviderID`), `cancel` on column move.
- `src/server/services/project.ts` — project create/update, `existsSync(.git)` path validation. → `path_validate`.
- `src/server/ws/handlers/projects.ts` (~L56) — emits `sync` with `providers: getProvidersForClient()`.
- `src/shared/ws-protocol.ts` — `SyncPayload`, `ProvidersMap`, zod schemas for the FE wire.
- `app/stores/config-store.ts` — FE `ConfigStore.hydrate(providers)`.

---

## Phasing

- **Phase A — Protocol foundation** (Tasks 1-3): add `requestId`, `hello`/`capabilities`, worktree/path actions to the shared protocol types. No behavior yet.
- **Phase B — orcd server** (Tasks 4-9): TCP listener, token auth, capabilities, node-local filesystem actions.
- **Phase C — config split** (Tasks 10-12): `orcd.yaml` (listen/authToken), `orc.yaml` node registry loader.
- **Phase D — BE client + registry** (Tasks 13-17): TCP `OrcdClient` with hello + requestId correlation + capability cache; multi-client registry in init-state.
- **Phase E — BE routing & fs removal** (Tasks 18-22): route by `node_name`; replace local worktree/path calls with protocol calls; delete `config/providers.ts`.
- **Phase F — data model** (Tasks 23-24): `node_name` columns + backfill.
- **Phase G — FE** (Tasks 25-28): node-aware sync payload, project/card forms, offline-node read-only cards.
- **Phase H — integration** (Task 29): two-orcd integration test.

Each task is independently committable. Run `pnpm test` (full suite) at phase boundaries; per-task runs target the specific file.

---

## Phase A — Protocol foundation

### Task 1: Add `requestId` to all client→orcd actions

**Files:**
- Modify: `src/shared/orcd-protocol.ts`
- Test: `src/shared/orcd-protocol.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import type { OrcdAction, OrcdMessage } from './orcd-protocol';

describe('orcd-protocol requestId', () => {
  it('allows an optional requestId on actions', () => {
    const a: OrcdAction = { action: 'list', requestId: 'r1' };
    expect(a.requestId).toBe('r1');
  });

  it('allows requestId to be omitted', () => {
    const a: OrcdAction = { action: 'list' };
    expect(a.requestId).toBeUndefined();
  });

  it('allows requestId echo on messages', () => {
    const m: OrcdMessage = { type: 'session_list', sessions: [], requestId: 'r1' };
    expect(m.requestId).toBe('r1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/shared/orcd-protocol.test.ts`
Expected: FAIL — `requestId` does not exist on `ListAction` / `SessionListMessage`.

- [ ] **Step 3: Add `requestId` to action and message types**

In `src/shared/orcd-protocol.ts`, add `requestId?: string;` to every action interface (`CreateAction`, `MessageAction`, `SetEffortAction`, `SubscribeAction`, `UnsubscribeAction`, `ListAction`, `CancelAction`, `MemoryUpsertAction`, `CompactAction`) and to `SessionListMessage`, `SessionErrorMessage`. Example for `ListAction`:

```ts
export interface ListAction {
  action: 'list';
  requestId?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/orcd-protocol.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/orcd-protocol.ts src/shared/orcd-protocol.test.ts
git commit -m "feat(protocol): add optional requestId for request/reply correlation"
```

### Task 2: Add `hello` action and `capabilities` message

**Files:**
- Modify: `src/shared/orcd-protocol.ts`
- Test: `src/shared/orcd-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('models hello action and capabilities message', () => {
  const hello: OrcdAction = { action: 'hello', token: 'secret', requestId: 'h1' };
  expect(hello.action).toBe('hello');

  const caps: OrcdMessage = {
    type: 'capabilities',
    requestId: 'h1',
    name: 'gpubox',
    providers: [
      { id: 'anthropic', label: 'Anthropic', models: [{ alias: 'sonnet', label: 'Sonnet', contextWindow: 1000000 }] },
    ],
    defaults: { provider: 'anthropic', model: 'sonnet' },
  };
  expect(caps.type).toBe('capabilities');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/shared/orcd-protocol.test.ts`
Expected: FAIL — `'hello'` not assignable; `CapabilitiesMessage` missing.

- [ ] **Step 3: Add the types**

In `src/shared/orcd-protocol.ts`:

```ts
export interface HelloAction {
  action: 'hello';
  token: string;
  requestId?: string;
}

export interface CapabilitiesAction {
  action: 'capabilities';
  requestId?: string;
}

export interface CapabilityProvider {
  id: string;
  label: string;
  models: Array<{ alias: string; label: string; contextWindow: number }>;
}

export interface CapabilitiesMessage {
  type: 'capabilities';
  requestId?: string;
  name: string;
  providers: CapabilityProvider[];
  defaults: { provider: string; model: string };
}
```

Add `HelloAction | CapabilitiesAction` to the `OrcdAction` union and `CapabilitiesMessage` to the `OrcdMessage` union.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/orcd-protocol.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/orcd-protocol.ts src/shared/orcd-protocol.test.ts
git commit -m "feat(protocol): add hello action and capabilities message"
```

### Task 3: Add worktree/path actions and replies

**Files:**
- Modify: `src/shared/orcd-protocol.ts`
- Test: `src/shared/orcd-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('models worktree and path actions with replies', () => {
  const prep: OrcdAction = {
    action: 'worktree_prepare', requestId: 'w1',
    projectPath: '/repo', branch: 'feat-x', sourceBranch: 'main', setupCommands: 'pnpm i',
  };
  expect(prep.action).toBe('worktree_prepare');

  const ready: OrcdMessage = { type: 'worktree_ready', requestId: 'w1', path: '/repo/.worktrees/feat-x', branch: 'feat-x' };
  expect(ready.type).toBe('worktree_ready');

  const rm: OrcdAction = { action: 'worktree_remove', requestId: 'w2', projectPath: '/repo', path: '/repo/.worktrees/feat-x' };
  expect(rm.action).toBe('worktree_remove');

  const ok: OrcdMessage = { type: 'ok', requestId: 'w2' };
  expect(ok.type).toBe('ok');

  const pv: OrcdAction = { action: 'path_validate', requestId: 'p1', path: '/repo' };
  expect(pv.action).toBe('path_validate');

  const pvr: OrcdMessage = { type: 'path_validated', requestId: 'p1', exists: true, isGitRepo: true, defaultBranch: 'main' };
  expect(pvr.type).toBe('path_validated');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/shared/orcd-protocol.test.ts`
Expected: FAIL — new actions/messages not in unions.

- [ ] **Step 3: Add the types**

In `src/shared/orcd-protocol.ts`:

```ts
export interface WorktreePrepareAction {
  action: 'worktree_prepare';
  requestId?: string;
  projectPath: string;
  branch: string;
  sourceBranch?: string;
  setupCommands?: string;
}

export interface WorktreeRemoveAction {
  action: 'worktree_remove';
  requestId?: string;
  projectPath: string;
  path: string;
}

export interface PathValidateAction {
  action: 'path_validate';
  requestId?: string;
  path: string;
}

export interface WorktreeReadyMessage {
  type: 'worktree_ready';
  requestId?: string;
  path: string;
  branch: string;
}

export interface OkMessage {
  type: 'ok';
  requestId?: string;
}

export interface PathValidatedMessage {
  type: 'path_validated';
  requestId?: string;
  exists: boolean;
  isGitRepo: boolean;
  defaultBranch: string | null;
}
```

Add `WorktreePrepareAction | WorktreeRemoveAction | PathValidateAction` to `OrcdAction` and `WorktreeReadyMessage | OkMessage | PathValidatedMessage` to `OrcdMessage`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/orcd-protocol.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/orcd-protocol.ts src/shared/orcd-protocol.test.ts
git commit -m "feat(protocol): add worktree_prepare/remove and path_validate actions"
```

---

## Phase B — orcd server (TCP, auth, capabilities, node-local fs)

Phase B changes `OrcdServer`'s constructor and connection handling. Existing tests construct it as `new OrcdServer('/tmp/orcd-test.sock', providers, defaults, memoryCfg)`. We replace the socket-path string with a `listen` object + `authToken` + `name`, and update the existing test helper accordingly.

### Task 4: Switch `OrcdServer` to a TCP listener

**Files:**
- Modify: `src/orcd/socket-server.ts`
- Modify: `src/orcd/index.ts`
- Modify: `src/orcd/__tests__/socket-server-compaction.test.ts` (update `createServer` helper)
- Test: `src/orcd/__tests__/socket-server-tcp.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, afterEach } from 'vitest';
import { createConnection } from 'net';
import { OrcdServer } from '../socket-server';

function freePort() { return 7400 + Math.floor(Math.random() * 500); }

describe('OrcdServer TCP listener', () => {
  let server: OrcdServer | null = null;
  afterEach(() => { server?.stop(); server = null; });

  it('listens on host:port and accepts a TCP connection', async () => {
    const port = freePort();
    server = new OrcdServer(
      { listen: { host: '127.0.0.1', port }, authToken: 'tok', name: 'local' },
      { test: { type: 'anthropic', baseUrl: '', apiKey: '', models: ['m'], modelAliasEnv: {} } },
      { provider: 'test', model: 'm' },
    );
    await server.start();
    await new Promise<void>((resolve, reject) => {
      const c = createConnection({ host: '127.0.0.1', port }, () => { c.end(); resolve(); });
      c.on('error', reject);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/orcd/__tests__/socket-server-tcp.test.ts`
Expected: FAIL — constructor signature mismatch; no TCP listen.

- [ ] **Step 3: Change the constructor and `start`/`stop`**

In `src/orcd/socket-server.ts`, replace the unix-socket constructor and start/stop. New constructor:

```ts
export interface OrcdListenConfig {
  listen: { host: string; port: number };
  authToken: string;
  name: string;
}

// in class OrcdServer:
constructor(
  private opts: OrcdListenConfig,
  private providers: Record<string, ProviderConfig>,
  private defaults: { provider: string; model: string },
  memoryConfig?: OrcdConfig['memoryUpsert'],
) {
  this.memoryConfig = memoryConfig;
}
```

Replace `start()`:

```ts
start(): Promise<void> {
  return new Promise((resolve, reject) => {
    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.on('error', reject);
    this.server.listen(this.opts.listen.port, this.opts.listen.host, () => {
      console.log(`[orcd] listening on ${this.opts.listen.host}:${this.opts.listen.port}`);
      resolve();
    });
  });
}
```

Replace `stop()` — remove all socket-file unlink logic:

```ts
stop(): void {
  for (const client of this.clients) client.socket.destroy();
  this.server?.close();
  console.log('[orcd] stopped');
}
```

Remove now-unused imports (`existsSync`, `mkdirSync`, `unlinkSync`, `dirname`) and the `socketPath` field.

- [ ] **Step 4: Update `src/orcd/index.ts`**

```ts
import { loadOrcdConfig } from './config';
import { OrcdServer } from './socket-server';

async function main() {
  console.log('[orcd] starting...');
  const config = await loadOrcdConfig();
  const server = new OrcdServer(
    { listen: config.listen, authToken: config.authToken, name: config.name },
    config.providers,
    { provider: config.defaultProvider, model: config.defaultModel },
    config.memoryUpsert,
  );
  await server.start();
  const shutdown = () => { console.log('[orcd] shutting down...'); server.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch((err) => { console.error('[orcd] fatal:', err); process.exit(1); });
```

> Note: `config.listen`, `config.authToken`, `config.name` are added in Task 10. Until then this file will not type-check against the old config — implement Task 10 before running the full build, or stub the fields. Per-task test for Task 4 does not import `index.ts`.

- [ ] **Step 5: Update the existing test helper**

In `src/orcd/__tests__/socket-server-compaction.test.ts`, change `createServer`:

```ts
function createServer() {
  return new OrcdServer(
    { listen: { host: '127.0.0.1', port: 0 }, authToken: 'tok', name: 'local' },
    { test: { type: 'anthropic', baseUrl: '', apiKey: '', models: ['test-model'], modelAliasEnv: {} } },
    { provider: 'test', model: 'test-model' },
  );
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm test src/orcd/__tests__/socket-server-tcp.test.ts src/orcd/__tests__/socket-server-compaction.test.ts`
Expected: PASS (compaction tests call `handleAction` directly and never bind, so port 0 is harmless).

- [ ] **Step 7: Commit**

```bash
git add src/orcd/socket-server.ts src/orcd/index.ts src/orcd/__tests__/
git commit -m "feat(orcd): bind TCP listener instead of unix socket"
```

### Task 5: Per-connection auth flag + `hello` handshake

**Files:**
- Modify: `src/orcd/socket-server.ts`
- Test: `src/orcd/__tests__/socket-server-auth.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, afterEach } from 'vitest';
import { createConnection, type Socket } from 'net';
import { OrcdServer } from '../socket-server';

function freePort() { return 7000 + Math.floor(Math.random() * 500); }

async function connectAndSend(port: number, lines: object[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    const c: Socket = createConnection({ host: '127.0.0.1', port }, () => {
      for (const l of lines) c.write(JSON.stringify(l) + '\n');
    });
    c.on('data', (d) => { out.push(...d.toString().split('\n').filter(Boolean)); });
    c.on('close', () => resolve(out));
    c.on('error', reject);
    setTimeout(() => c.end(), 150);
  });
}

describe('OrcdServer auth', () => {
  let server: OrcdServer | null = null;
  afterEach(() => { server?.stop(); server = null; });

  async function boot() {
    const port = freePort();
    server = new OrcdServer(
      { listen: { host: '127.0.0.1', port }, authToken: 'right', name: 'local' },
      { test: { type: 'anthropic', baseUrl: '', apiKey: '', models: ['m'], modelAliasEnv: {} } },
      { provider: 'test', model: 'm' },
    );
    await server.start();
    return port;
  }

  it('replies capabilities on a valid hello', async () => {
    const port = await boot();
    const out = await connectAndSend(port, [{ action: 'hello', token: 'right', requestId: 'h1' }]);
    const msgs = out.map((l) => JSON.parse(l));
    expect(msgs.some((m) => m.type === 'capabilities' && m.requestId === 'h1')).toBe(true);
  });

  it('rejects and closes on a bad token', async () => {
    const port = await boot();
    const out = await connectAndSend(port, [{ action: 'hello', token: 'wrong', requestId: 'h1' }]);
    const msgs = out.map((l) => JSON.parse(l));
    expect(msgs.some((m) => m.type === 'error')).toBe(true);
  });

  it('drops actions issued before hello', async () => {
    const port = await boot();
    const out = await connectAndSend(port, [{ action: 'list', requestId: 'l1' }]);
    const msgs = out.map((l) => JSON.parse(l));
    expect(msgs.some((m) => m.type === 'session_list')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/orcd/__tests__/socket-server-auth.test.ts`
Expected: FAIL — no hello handling; `list` answered without auth.

- [ ] **Step 3: Implement auth gating**

In `src/orcd/socket-server.ts`, add `authenticated: boolean` to `ClientState`:

```ts
interface ClientState {
  socket: Socket;
  subscriptions: Map<string, SessionEventCallback>;
  authenticated: boolean;
}
```

Set `authenticated: false` in `handleConnection`. At the top of `handleAction`, gate everything behind auth:

```ts
private handleAction(client: ClientState, action: OrcdAction): void {
  if (action.action === 'hello') {
    this.handleHello(client, action);
    return;
  }
  if (!client.authenticated) {
    console.warn('[orcd] dropping action before hello:', action.action);
    return;
  }
  switch (action.action) {
    // ... existing cases ...
    case 'capabilities':
      this.send(client, this.buildCapabilities(action.requestId));
      break;
  }
}
```

Add the handlers (capabilities builder lands in Task 6 — stub it here returning the minimal shape, or implement Task 6 first):

```ts
private handleHello(client: ClientState, action: OrcdAction & { action: 'hello' }): void {
  if (action.token !== this.opts.authToken) {
    this.send(client, { type: 'error', sessionId: '', error: 'invalid token', requestId: action.requestId });
    client.socket.destroy();
    return;
  }
  client.authenticated = true;
  this.send(client, this.buildCapabilities(action.requestId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/orcd/__tests__/socket-server-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orcd/socket-server.ts src/orcd/__tests__/socket-server-auth.test.ts
git commit -m "feat(orcd): require hello token auth before any action"
```

### Task 6: Build the `capabilities` payload from loaded providers

**Files:**
- Modify: `src/orcd/socket-server.ts`
- Test: `src/orcd/__tests__/socket-server-capabilities.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { OrcdServer } from '../socket-server';

describe('buildCapabilities', () => {
  it('maps providers/models to the capabilities payload', () => {
    const server = new OrcdServer(
      { listen: { host: '127.0.0.1', port: 0 }, authToken: 't', name: 'gpubox' },
      {
        anthropic: {
          type: 'anthropic', baseUrl: '', apiKey: '', modelAliasEnv: {},
          models: ['claude-sonnet-4-6'],
          modelLabels: { 'claude-sonnet-4-6': { alias: 'sonnet', label: 'Sonnet', contextWindow: 1000000 } },
        },
      },
      { provider: 'anthropic', model: 'sonnet' },
    );
    const caps = server['buildCapabilities']('h1');
    expect(caps).toMatchObject({
      type: 'capabilities', requestId: 'h1', name: 'gpubox',
      defaults: { provider: 'anthropic', model: 'sonnet' },
    });
    expect(caps.providers[0]).toMatchObject({ id: 'anthropic', label: 'Anthropic' });
    expect(caps.providers[0].models[0]).toMatchObject({ alias: 'sonnet', label: 'Sonnet', contextWindow: 1000000 });
  });
});
```

> **Decision needed:** orcd's `ProviderConfig` currently flattens models to `string[]` (modelIDs only), losing alias/label/contextWindow. The capabilities payload needs alias + label + contextWindow. Carry the richer model info onto orcd's `ProviderConfig` (add a `modelLabels` map and a provider `label`) in Task 11's config changes. This task assumes those fields exist; sequence Task 11 before Task 6, or add the fields to `ProviderConfig` here.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/orcd/__tests__/socket-server-capabilities.test.ts`
Expected: FAIL — `buildCapabilities` undefined.

- [ ] **Step 3: Implement `buildCapabilities`**

```ts
private buildCapabilities(requestId?: string): CapabilitiesMessage {
  const providers = Object.entries(this.providers).map(([id, cfg]) => ({
    id,
    label: cfg.label ?? id,
    models: Object.entries(cfg.modelLabels ?? {}).map(([modelID, m]) => ({
      alias: m.alias, label: m.label, contextWindow: m.contextWindow,
    })),
  }));
  return { type: 'capabilities', requestId, name: this.opts.name, providers, defaults: this.defaults };
}
```

Import `CapabilitiesMessage` from `../shared/orcd-protocol`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/orcd/__tests__/socket-server-capabilities.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orcd/socket-server.ts src/orcd/__tests__/socket-server-capabilities.test.ts
git commit -m "feat(orcd): build capabilities payload from providers"
```

### Task 7: `worktree_prepare` / `worktree_remove` on orcd

**Files:**
- Create: `src/orcd/worktree-ops.ts` (move logic from `src/server/worktree.ts`)
- Modify: `src/orcd/socket-server.ts`
- Test: `src/orcd/__tests__/worktree-ops.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { prepareWorktree, removeWorktree } from '../worktree-ops';

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orcd-wt-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('worktree-ops', () => {
  let repo: string;
  afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

  it('prepares a worktree and returns its resolved path', async () => {
    repo = await tempRepo();
    const res = await prepareWorktree({ projectPath: repo, branch: 'feat-x', sourceBranch: undefined, setupCommands: '' });
    expect(res.path).toBe(join(repo, '.worktrees', 'feat-x'));
    expect((await stat(res.path)).isDirectory()).toBe(true);
  });

  it('removes a worktree', async () => {
    repo = await tempRepo();
    const res = await prepareWorktree({ projectPath: repo, branch: 'feat-y', sourceBranch: undefined, setupCommands: '' });
    await removeWorktree(repo, res.path);
    await expect(stat(res.path)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/orcd/__tests__/worktree-ops.test.ts`
Expected: FAIL — `worktree-ops` module missing.

- [ ] **Step 3: Create `src/orcd/worktree-ops.ts`**

Move the implementation from `src/server/worktree.ts` (git create/remove, setup commands, opencode copy) and add a `prepareWorktree` that composes them. Reuse `resolveWorkDir` from `../shared/worktree`.

```ts
import { execFile, execFileSync } from 'child_process';
import { existsSync, copyFileSync } from 'fs';
import { dirname } from 'path';
import { promisify } from 'util';
import { resolveWorkDir } from '../shared/worktree';

const execFileAsync = promisify(execFile);

function createWorktree(repoPath: string, worktreePath: string, branch: string, sourceBranch?: string): void {
  let resolvedSource = sourceBranch;
  if (sourceBranch && !sourceBranch.includes('/')) {
    execFileSync('git', ['fetch', 'origin', sourceBranch], { cwd: repoPath, stdio: 'pipe' });
    resolvedSource = `origin/${sourceBranch}`;
  }
  try {
    execFileSync('git', ['worktree', 'add', worktreePath, branch], { cwd: repoPath, stdio: 'pipe' });
  } catch (err) {
    console.log(`[worktree:${branch}] attach failed, creating new branch:`, err instanceof Error ? err.message : err);
    const args = ['worktree', 'add', worktreePath, '-b', branch];
    if (resolvedSource) args.push(resolvedSource);
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  }
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath, stdio: 'pipe' });
}

async function runSetupCommands(worktreePath: string, commands: string): Promise<void> {
  if (!commands.trim()) return;
  const nodeBin = dirname(process.execPath);
  await execFileAsync('/bin/bash', ['-lc', `export PATH="${nodeBin}:$HOME/.local/bin:$PATH"; ${commands}`], {
    cwd: worktreePath,
    env: { ...process.env, PATH: `${nodeBin}:${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}` },
    timeout: 120_000,
  });
}

function copyOpencodeConfig(srcDir: string, destDir: string): void {
  const src = `${srcDir}/opencode.json`;
  if (!existsSync(src)) return;
  copyFileSync(src, `${destDir}/opencode.json`);
}

export async function prepareWorktree(opts: {
  projectPath: string; branch: string; sourceBranch?: string; setupCommands?: string;
}): Promise<{ path: string; branch: string }> {
  const wtPath = resolveWorkDir(opts.branch, opts.projectPath);
  if (!existsSync(wtPath)) {
    createWorktree(opts.projectPath, wtPath, opts.branch, opts.sourceBranch);
    if (opts.setupCommands) {
      try {
        await runSetupCommands(wtPath, opts.setupCommands);
      } catch (err) {
        // Setup failure must not block the session — the worktree exists and the agent can run.
        console.error(`[worktree:${opts.branch}] setup failed (continuing):`, err instanceof Error ? err.message : String(err));
      }
    }
    copyOpencodeConfig(opts.projectPath, wtPath);
  }
  return { path: wtPath, branch: opts.branch };
}
```

> Note the PATH change: the BE version hardcoded `/home/ryan/.local/bin` and ran under the web service's env. On a node, use `$HOME/.local/bin` so it resolves on whatever box orcd runs on.

- [ ] **Step 4: Wire the actions in `socket-server.ts`**

In `handleAction`, add cases (after the auth gate):

```ts
case 'worktree_prepare':
  this.handleWorktreePrepare(client, action);
  break;
case 'worktree_remove':
  this.handleWorktreeRemove(client, action);
  break;
```

Handlers:

```ts
private async handleWorktreePrepare(client: ClientState, action: OrcdAction & { action: 'worktree_prepare' }): Promise<void> {
  try {
    const { prepareWorktree } = await import('./worktree-ops');
    const res = await prepareWorktree({
      projectPath: action.projectPath, branch: action.branch,
      sourceBranch: action.sourceBranch, setupCommands: action.setupCommands,
    });
    this.send(client, { type: 'worktree_ready', requestId: action.requestId, path: res.path, branch: res.branch });
  } catch (err) {
    this.send(client, { type: 'error', sessionId: '', requestId: action.requestId, error: err instanceof Error ? err.message : String(err) });
  }
}

private async handleWorktreeRemove(client: ClientState, action: OrcdAction & { action: 'worktree_remove' }): Promise<void> {
  try {
    const { existsSync } = await import('fs');
    const { removeWorktree } = await import('./worktree-ops');
    if (existsSync(action.path)) removeWorktree(action.projectPath, action.path);
    this.send(client, { type: 'ok', requestId: action.requestId });
  } catch (err) {
    this.send(client, { type: 'error', sessionId: '', requestId: action.requestId, error: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/orcd/__tests__/worktree-ops.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/orcd/worktree-ops.ts src/orcd/socket-server.ts src/orcd/__tests__/worktree-ops.test.ts
git commit -m "feat(orcd): own worktree prepare/remove on the node"
```

### Task 8: `path_validate` on orcd

**Files:**
- Modify: `src/orcd/worktree-ops.ts`
- Modify: `src/orcd/socket-server.ts`
- Test: `src/orcd/__tests__/path-validate.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { validatePath } from '../worktree-ops';

describe('validatePath', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('reports a non-existent path', async () => {
    const res = await validatePath('/no/such/path-xyz');
    expect(res).toEqual({ exists: false, isGitRepo: false, defaultBranch: null });
  });

  it('detects a git repo and its default branch', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orcd-pv-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    const res = await validatePath(dir);
    expect(res.exists).toBe(true);
    expect(res.isGitRepo).toBe(true);
    expect(res.defaultBranch).toBe('main');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/orcd/__tests__/path-validate.test.ts`
Expected: FAIL — `validatePath` undefined.

- [ ] **Step 3: Implement `validatePath`**

Add to `src/orcd/worktree-ops.ts`:

```ts
import { join } from 'path';

export async function validatePath(path: string): Promise<{ exists: boolean; isGitRepo: boolean; defaultBranch: string | null }> {
  if (!existsSync(path)) return { exists: false, isGitRepo: false, defaultBranch: null };
  const isGitRepo = existsSync(join(path, '.git'));
  let defaultBranch: string | null = null;
  if (isGitRepo) {
    try {
      defaultBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path, stdio: 'pipe' }).toString().trim() || null;
    } catch (err) {
      console.log(`[path_validate] could not resolve branch for ${path}:`, err instanceof Error ? err.message : err);
    }
  }
  return { exists: true, isGitRepo, defaultBranch };
}
```

Add `join` to the existing `path` import.

- [ ] **Step 4: Wire the action**

In `handleAction`:

```ts
case 'path_validate':
  this.handlePathValidate(client, action);
  break;
```

```ts
private async handlePathValidate(client: ClientState, action: OrcdAction & { action: 'path_validate' }): Promise<void> {
  const { validatePath } = await import('./worktree-ops');
  const res = await validatePath(action.path);
  this.send(client, { type: 'path_validated', requestId: action.requestId, ...res });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/orcd/__tests__/path-validate.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/orcd/worktree-ops.ts src/orcd/socket-server.ts src/orcd/__tests__/path-validate.test.ts
git commit -m "feat(orcd): path_validate against the node filesystem"
```

### Task 9: Phase B regression check

- [ ] **Step 1: Run the orcd suite**

Run: `pnpm test src/orcd/`
Expected: PASS (all orcd tests, including updated compaction helper).

- [ ] **Step 2: Commit if any fixups were needed**

```bash
git add -A && git commit -m "test(orcd): phase B regression fixups" || echo "nothing to commit"
```

---

## Phase C — config split

orcd's shared config loader (`src/shared/config.ts`) gains `listen`/`authToken`/`name` and drops the required `socket`. orcd's shaped config (`src/orcd/config.ts`) carries richer model info (`label`, `modelLabels`) for capabilities. A new BE-only `orc.yaml` loader reads the node registry.

### Task 10: Add `listen`/`authToken`/`name` to the shared config loader

**Files:**
- Modify: `src/shared/config.ts`
- Test: `src/shared/config.test.ts` (locate or create; check existing shared config tests)

- [ ] **Step 1: Write the failing test**

Add to the shared config test file (find existing tests for `parseConfig` in `src/shared/`; if none, create `src/shared/config.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { parseConfig } from './config';

describe('parseConfig listen/auth', () => {
  const base = `
listen:
  host: 0.0.0.0
  port: 7420
authToken: secret-tok
name: gpubox
defaultProvider: anthropic
defaultModel: sonnet
providers:
  anthropic:
    label: Anthropic
    models:
      sonnet: { label: "Sonnet", modelID: claude-sonnet-4-6, contextWindow: 1000000 }
`;
  it('parses listen, authToken, name', () => {
    const cfg = parseConfig(base, {});
    expect(cfg.listen).toEqual({ host: '0.0.0.0', port: 7420 });
    expect(cfg.authToken).toBe('secret-tok');
    expect(cfg.name).toBe('local'); // shared loader default; orcd overrides via env/name
  });
  it('resolves authToken env vars', () => {
    const cfg = parseConfig(base.replace('secret-tok', '${ORCD_TOKEN}'), { ORCD_TOKEN: 'xyz' });
    expect(cfg.authToken).toBe('xyz');
  });
});
```

> The `name` default: keep it simple — shared loader defaults `name` to the parsed `name` field or `'local'`. Adjust the assertion to match what you implement (`cfg.name` should equal `'gpubox'` if you read the `name` field; change the test to `expect(cfg.name).toBe('gpubox')`). Pick one and make the test match.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/shared/config.test.ts`
Expected: FAIL — `listen`/`authToken`/`name` not on `OrchestrelConfig`.

- [ ] **Step 3: Update `src/shared/config.ts`**

In the `OrchestrelConfig` interface, replace `socket: string;` with:

```ts
  listen: { host: string; port: number };
  authToken: string;
  name: string;
```

In `parseConfig`, parse them (with `resolveEnvVars` on `authToken`):

```ts
  const rawListen = (raw.listen ?? {}) as Record<string, unknown>;
  const listen = {
    host: String(rawListen.host ?? '127.0.0.1'),
    port: Number(rawListen.port ?? 7420),
  };
```

In the returned object, replace `socket: ...` with:

```ts
    listen,
    authToken: raw.authToken != null ? resolveEnvVars(String(raw.authToken), env) : '',
    name: raw.name != null ? String(raw.name) : 'local',
```

Remove the `socket` field from the interface and return object entirely.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/config.ts src/shared/config.test.ts
git commit -m "feat(config): add listen/authToken/name, drop socket"
```

### Task 11: Carry model labels into orcd's shaped config

**Files:**
- Modify: `src/orcd/config.ts`
- Modify: `src/orcd/__tests__/config.test.ts` (update YAML fixtures: drop `socket:`, assert `listen`)

- [ ] **Step 1: Update the failing tests**

In `src/orcd/__tests__/config.test.ts`, every fixture currently has `socket: ~/.orc/orcd.sock`. Replace with:

```yaml
listen: { host: 127.0.0.1, port: 7420 }
authToken: tok
```

Update the "throws on missing providers" fixture the same way. Add an assertion in the first parse test:

```ts
expect(cfg.listen).toEqual({ host: '127.0.0.1', port: 7420 });
expect(cfg.providers.anthropic.modelLabels['claude-sonnet-4-6']).toEqual({
  alias: 'sonnet', label: 'Sonnet 4.6', contextWindow: 200000,
});
expect(cfg.providers.anthropic.label).toBe('Anthropic');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/orcd/__tests__/config.test.ts`
Expected: FAIL — `listen`/`modelLabels`/`label` not present.

- [ ] **Step 3: Update `src/orcd/config.ts`**

Extend `ProviderConfig` and `OrcdConfig`:

```ts
export interface ProviderConfig {
  type: ProviderType;
  label?: string;
  baseUrl: string;
  apiKey: string;
  authToken?: string;
  region?: string;
  profile?: string;
  models: string[];
  modelLabels: Record<string, { alias: string; label: string; contextWindow: number }>;
  modelAliasEnv: Record<string, string>;
}

export interface OrcdConfig {
  listen: { host: string; port: number };
  authToken: string;
  name: string;
  defaultProvider: string;
  defaultModel: string;
  defaultCwd?: string;
  providers: Record<string, ProviderConfig>;
  memoryUpsert?: MemoryUpsertConfig;
}
```

In `toOrcdShape`, build `modelLabels` (key by modelID, matching `models: string[]`) and pass `label`:

```ts
    const modelLabels: Record<string, { alias: string; label: string; contextWindow: number }> = {};
    for (const [alias, m] of Object.entries(p.models)) {
      modelLabels[m.modelID] = { alias, label: m.label, contextWindow: m.contextWindow };
    }
    providers[id] = {
      type: p.type ?? 'anthropic',
      ...(p.label ? { label: p.label } : {}),
      baseUrl: p.baseUrl ?? '',
      apiKey: p.apiKey ?? '',
      ...(p.authToken ? { authToken: p.authToken } : {}),
      ...(p.region ? { region: p.region } : {}),
      ...(p.profile ? { profile: p.profile } : {}),
      models: Object.values(p.models).map((m) => m.modelID),
      modelLabels,
      modelAliasEnv: buildModelAliasEnv(p.models, p.aliases),
    };
```

Replace the returned `socket: cfg.socket` with `listen: cfg.listen, authToken: cfg.authToken, name: cfg.name`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/orcd/__tests__/config.test.ts`
Expected: PASS

- [ ] **Step 5: Update example config + rename guidance**

Edit `config.example.yaml`: remove the `socket:` line, add:

```yaml
listen:
  host: 0.0.0.0
  port: 7420
authToken: ${ORCD_TOKEN}
name: local
```

Update the top comment to say the file is now `orcd.yaml` (per box). Rename the example file:

```bash
git mv config.example.yaml orcd.example.yaml
```

- [ ] **Step 6: Run the orcd suite + commit**

Run: `pnpm test src/orcd/`
Expected: PASS

```bash
git add src/orcd/config.ts src/orcd/__tests__/config.test.ts orcd.example.yaml
git commit -m "feat(config): orcd carries model labels; example renamed to orcd.example.yaml"
```

### Task 12: `orc.yaml` node-registry loader (BE)

**Files:**
- Create: `src/server/config/nodes.ts`
- Create: `orc.example.yaml`
- Test: `src/server/config/nodes.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseNodeRegistry } from './nodes';

describe('parseNodeRegistry', () => {
  it('parses servers with env-resolved tokens', () => {
    const yaml = `
servers:
  - name: local
    host: 127.0.0.1
    port: 7420
    authToken: \${LOCAL_TOKEN}
  - name: gpubox
    host: 10.8.0.3
    port: 7420
    authToken: gpu-tok
`;
    const nodes = parseNodeRegistry(yaml, { LOCAL_TOKEN: 'l-tok' });
    expect(nodes).toEqual([
      { name: 'local', host: '127.0.0.1', port: 7420, authToken: 'l-tok' },
      { name: 'gpubox', host: '10.8.0.3', port: 7420, authToken: 'gpu-tok' },
    ]);
  });

  it('throws when servers is missing', () => {
    expect(() => parseNodeRegistry('foo: bar', {})).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/config/nodes.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/server/config/nodes.ts`**

```ts
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { resolveEnvVars } from '../../shared/config';

export interface NodeEntry {
  name: string;
  host: string;
  port: number;
  authToken: string;
}

export function parseNodeRegistry(yamlStr: string, env: Record<string, string | undefined>): NodeEntry[] {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;
  if (!Array.isArray(raw.servers)) throw new Error('orc.yaml: "servers" must be an array');
  return (raw.servers as Record<string, unknown>[]).map((s) => ({
    name: String(s.name),
    host: String(s.host),
    port: Number(s.port),
    authToken: s.authToken != null ? resolveEnvVars(String(s.authToken), env) : '',
  }));
}

export function nodeRegistryPath(): string {
  return process.env.ORC_NODES ?? resolve(process.cwd(), 'orc.yaml');
}

let cached: NodeEntry[] | null = null;

export function loadNodeRegistry(): NodeEntry[] {
  if (cached) return cached;
  const path = nodeRegistryPath();
  if (!existsSync(path)) throw new Error(`orc.yaml not found at ${path}`);
  cached = parseNodeRegistry(readFileSync(path, 'utf-8'), process.env as Record<string, string | undefined>);
  return cached;
}

export function resetNodeRegistryCache(): void { cached = null; }
```

- [ ] **Step 4: Create `orc.example.yaml`**

```yaml
# orc.yaml — node registry, owned by the BE. Copy to orc.yaml (gitignored).
servers:
  - name: local
    host: 127.0.0.1
    port: 7420
    authToken: ${LOCAL_ORCD_TOKEN}
  # - name: gpubox
  #   host: 10.8.0.3
  #   port: 7420
  #   authToken: ${GPUBOX_ORCD_TOKEN}
```

- [ ] **Step 5: Run test + commit**

Run: `pnpm test src/server/config/nodes.test.ts`
Expected: PASS

```bash
git add src/server/config/nodes.ts src/server/config/nodes.test.ts orc.example.yaml
echo "orc.yaml" >> .gitignore
git add .gitignore
git commit -m "feat(config): orc.yaml node registry loader"
```

---

## Phase D — BE client + registry

`OrcdClient` switches from a unix socket to TCP, performs the `hello` handshake, caches capabilities, and gains generic `requestId` request/reply correlation. A registry in `init-state` holds one client per node.

### Task 13: `OrcdClient` dials TCP with `{ host, port, token }`

**Files:**
- Modify: `src/server/orcd-client.ts`
- Modify: `src/server/orcd-client.test.ts` (constructor calls)
- Test: same file

- [ ] **Step 1: Write the failing test**

Add to `src/server/orcd-client.test.ts`:

```ts
it('constructs with host/port/token options', () => {
  const client = new OrcdClient({ host: '10.0.0.1', port: 7420, token: 'tok', name: 'gpubox' });
  expect(client.nodeName).toBe('gpubox');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/orcd-client.test.ts`
Expected: FAIL — constructor takes a string path; no `nodeName`.

- [ ] **Step 3: Change the constructor + connect**

In `src/server/orcd-client.ts`, replace the constructor:

```ts
export interface OrcdClientOpts {
  host: string;
  port: number;
  token: string;
  name: string;
}

// fields:
readonly nodeName: string;
private opts: OrcdClientOpts;

constructor(opts: OrcdClientOpts) {
  this.opts = opts;
  this.nodeName = opts.name;
}
```

Replace `connect()`'s dial. Swap `createConnection({ path }, ...)` for:

```ts
const sock = createConnection({ host: this.opts.host, port: this.opts.port }, () => {
  this.connected = true;
  this.buf = '';
  const isReconnect = this.hasConnectedBefore;
  this.hasConnectedBefore = true;
  console.log(`[orcd-client:${this.nodeName}] ${isReconnect ? 're' : ''}connected`);
  // hello handshake happens in Task 14; for now resolve directly
  if (isReconnect) this.reconnectCallback?.();
  resolve();
});
```

Remove the `homedir` import and `socketPath` default. Update the existing tests that call `new OrcdClient('/tmp/test.sock')` to `new OrcdClient({ host: '127.0.0.1', port: 0, token: 't', name: 'local' })` — they stub `internals.socket`/`internals.send` so they never actually dial.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/server/orcd-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/orcd-client.ts src/server/orcd-client.test.ts
git commit -m "feat(be): OrcdClient dials TCP with node options"
```

### Task 14: Generic `requestId` request/reply + `hello` handshake + capability cache

**Files:**
- Modify: `src/server/orcd-client.ts`
- Test: `src/server/orcd-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('correlates a request by requestId and resolves on reply', async () => {
  const client = new OrcdClient({ host: '127.0.0.1', port: 0, token: 't', name: 'local' });
  const internals = client as unknown as {
    socket: { writable: boolean };
    send: (a: { requestId?: string }) => void;
    dispatch: (m: unknown) => void;
  };
  internals.socket = { writable: true };
  internals.send = (a) => {
    internals.dispatch({ type: 'path_validated', requestId: a.requestId, exists: true, isGitRepo: true, defaultBranch: 'main' });
  };
  const res = await client.pathValidate('/repo');
  expect(res).toMatchObject({ exists: true, isGitRepo: true, defaultBranch: 'main' });
});

it('caches capabilities from a hello reply', async () => {
  const client = new OrcdClient({ host: '127.0.0.1', port: 0, token: 't', name: 'local' });
  const internals = client as unknown as {
    socket: { writable: boolean };
    send: (a: { requestId?: string }) => void;
    dispatch: (m: unknown) => void;
  };
  internals.socket = { writable: true };
  internals.send = (a) => {
    internals.dispatch({
      type: 'capabilities', requestId: a.requestId, name: 'local',
      providers: [{ id: 'anthropic', label: 'Anthropic', models: [{ alias: 'sonnet', label: 'Sonnet', contextWindow: 1000000 }] }],
      defaults: { provider: 'anthropic', model: 'sonnet' },
    });
  };
  const caps = await client.sayHello();
  expect(caps.providers[0].id).toBe('anthropic');
  expect(client.capabilities?.name).toBe('local');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/orcd-client.test.ts`
Expected: FAIL — `pathValidate`/`sayHello`/`capabilities` undefined.

- [ ] **Step 3: Implement the generic pending-request map + methods**

Add fields and a counter:

```ts
private pending = new Map<string, { resolve: (m: OrcdMessage) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
private reqCounter = 0;
capabilities: import('../shared/orcd-protocol').CapabilitiesMessage | null = null;

private nextRequestId(): string {
  return `${this.nodeName}-${Date.now()}-${this.reqCounter++}`;
}

private request(action: OrcdAction): Promise<OrcdMessage> {
  const requestId = this.nextRequestId();
  return new Promise((resolve, reject) => {
    if (!this.socket?.writable) { reject(new Error(`OrcdClient[${this.nodeName}] not connected`)); return; }
    const timeout = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`request timeout: ${action.action}`)); }, 130_000);
    this.pending.set(requestId, { resolve, reject, timeout });
    this.send({ ...action, requestId });
  });
}
```

In `dispatch`, before the existing handler-fan-out, resolve pending requests:

```ts
const anyMsg = msg as OrcdMessage & { requestId?: string };
if (anyMsg.requestId && this.pending.has(anyMsg.requestId)) {
  const p = this.pending.get(anyMsg.requestId)!;
  clearTimeout(p.timeout);
  this.pending.delete(anyMsg.requestId);
  if (msg.type === 'error') p.reject(new Error((msg as { error: string }).error));
  else p.resolve(msg);
  return; // request/reply messages are not broadcast to general handlers
}
```

Add the public methods:

```ts
async sayHello(): Promise<import('../shared/orcd-protocol').CapabilitiesMessage> {
  const msg = await this.request({ action: 'hello', token: this.opts.token } as OrcdAction);
  if (msg.type !== 'capabilities') throw new Error('expected capabilities reply to hello');
  this.capabilities = msg;
  return msg;
}

async pathValidate(path: string): Promise<{ exists: boolean; isGitRepo: boolean; defaultBranch: string | null }> {
  const msg = await this.request({ action: 'path_validate', path } as OrcdAction);
  if (msg.type !== 'path_validated') throw new Error('expected path_validated reply');
  return { exists: msg.exists, isGitRepo: msg.isGitRepo, defaultBranch: msg.defaultBranch };
}

async worktreePrepare(opts: { projectPath: string; branch: string; sourceBranch?: string; setupCommands?: string }): Promise<{ path: string; branch: string }> {
  const msg = await this.request({ action: 'worktree_prepare', ...opts } as OrcdAction);
  if (msg.type !== 'worktree_ready') throw new Error('expected worktree_ready reply');
  return { path: msg.path, branch: msg.branch };
}

async worktreeRemove(projectPath: string, path: string): Promise<void> {
  const msg = await this.request({ action: 'worktree_remove', projectPath, path } as OrcdAction);
  if (msg.type !== 'ok') throw new Error('expected ok reply');
}
```

In `connect()`'s on-connect callback, perform the handshake before resolving:

```ts
this.connected = true;
this.buf = '';
const isReconnect = this.hasConnectedBefore;
this.hasConnectedBefore = true;
this.sayHello()
  .then(() => { if (isReconnect) this.reconnectCallback?.(); resolve(); })
  .catch((err) => { console.error(`[orcd-client:${this.nodeName}] hello failed:`, err.message); reject(err); });
```

> `list` and `create` keep their existing correlation (they don't set `requestId`, so the pending-request short-circuit won't capture them). Leave them as-is.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/server/orcd-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/orcd-client.ts src/server/orcd-client.test.ts
git commit -m "feat(be): requestId correlation, hello handshake, capability cache"
```

### Task 15: Multi-client registry in `init-state`

**Files:**
- Modify: `src/server/init-state.ts`
- Test: `src/server/init-state.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getOrcdClient, getClientByNode, setClientForNode, listNodeClients, clearNodeClients } from './init-state';

class FakeClient { constructor(public nodeName: string) {} }

describe('init-state node registry', () => {
  beforeEach(() => clearNodeClients());

  it('stores and retrieves clients by node name', () => {
    setClientForNode('local', new FakeClient('local') as never);
    setClientForNode('gpubox', new FakeClient('gpubox') as never);
    expect(getClientByNode('local')?.nodeName).toBe('local');
    expect(getClientByNode('gpubox')?.nodeName).toBe('gpubox');
    expect(listNodeClients().length).toBe(2);
  });

  it('getOrcdClient returns the local client for back-compat', () => {
    setClientForNode('local', new FakeClient('local') as never);
    expect(getOrcdClient()?.nodeName).toBe('local');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/init-state.test.ts`
Expected: FAIL — registry functions missing.

- [ ] **Step 3: Implement the registry**

In `src/server/init-state.ts`, replace the single-client block:

```ts
import type { OrcdClient } from './orcd-client'
const _nodeClients = new Map<string, OrcdClient>()
export function setClientForNode(name: string, client: OrcdClient): void { _nodeClients.set(name, client) }
export function getClientByNode(name: string): OrcdClient | null { return _nodeClients.get(name) ?? null }
export function listNodeClients(): OrcdClient[] { return [..._nodeClients.values()] }
export function clearNodeClients(): void { _nodeClients.clear() }
/** Back-compat: callers that predate multi-node default to the 'local' node. */
export function getOrcdClient(): OrcdClient | null { return _nodeClients.get('local') ?? null }
```

Remove `setOrcdClient` (callers move to `setClientForNode` in Task 16).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/server/init-state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/init-state.ts src/server/init-state.test.ts
git commit -m "feat(be): per-node OrcdClient registry in init-state"
```

### Task 16: Boot one client per node in `ws/server.ts`

**Files:**
- Modify: `src/server/ws/server.ts` (~L145-180)

- [ ] **Step 1: Replace single-client init with a per-node loop**

In the one-time init block, replace the single `OrcdClient` construction with:

```ts
const { OrcdClient } = await import('../orcd-client');
const { loadNodeRegistry } = await import('../config/nodes');
const { initOrcdRouter, reconcileRunningCards, registerAutoStart, registerWorktreeCleanup, registerMemoryUpsertOnArchive } =
  await import('../controllers/card-sessions');

const nodes = loadNodeRegistry();
for (const node of nodes) {
  let client = initState.getClientByNode(node.name);
  if (!client) {
    client = new OrcdClient({ host: node.host, port: node.port, token: node.authToken, name: node.name });
    initState.setClientForNode(node.name, client);
    try {
      await client.connect();
    } catch (err) {
      console.error(`[orcd] node ${node.name} initial connect failed (will retry):`, (err as Error).message);
    }
  }
  initOrcdRouter(client);
  try { await reconcileRunningCards(client); }
  catch (err) { console.error(`[startup] reconcile failed for ${node.name}:`, err); }
  client.onReconnect(() => {
    console.log(`[orcd] node ${node.name} reconnected, reconciling...`);
    reconcileRunningCards(client!).catch((e) => console.error(`[orcd] reconnect reconcile ${node.name}:`, e));
  });
}

registerAutoStart();
registerMemoryUpsertOnArchive();
registerWorktreeCleanup();
console.log(`[orcd] ${nodes.length} node client(s) initialized`);
```

> `OrcdClient.connect()` must not throw the whole boot if a node is offline — it's wrapped in try/catch and the existing reconnect timer keeps retrying. Verify `connect()`'s reject path still arms the reconnect timer; if the reject happens before the `close` handler is attached, add a reconnect schedule in the catch. (The current `connect` attaches `close`/`error` before resolving, so a failed initial dial fires `error` → reject; ensure a reconnect is scheduled on initial-failure too.)

- [ ] **Step 2: Verify the build type-checks**

Run: `pnpm build` (or `pnpm tsc --noEmit` if available)
Expected: no type errors from `ws/server.ts`.

- [ ] **Step 3: Run the server test suite**

Run: `pnpm test src/server/`
Expected: PASS (some routing tests update in Phase E; failures localized to routing land there).

- [ ] **Step 4: Commit**

```bash
git add src/server/ws/server.ts
git commit -m "feat(be): boot one OrcdClient per registry node"
```

### Task 17: Initial-connect failure schedules reconnect

**Files:**
- Modify: `src/server/orcd-client.ts`
- Test: `src/server/orcd-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('schedules a reconnect when the initial dial fails', async () => {
  const client = new OrcdClient({ host: '127.0.0.1', port: 1, token: 't', name: 'local' });
  await expect(client.connect()).rejects.toBeTruthy();
  const internals = client as unknown as { reconnectTimer: unknown };
  expect(internals.reconnectTimer).not.toBeNull();
  client.disconnect();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/orcd-client.test.ts`
Expected: FAIL — initial dial rejects without arming the timer.

- [ ] **Step 3: Arm the reconnect timer on initial-dial error**

In `connect()`'s `sock.on('error', ...)`, when not yet connected, schedule a reconnect before rejecting:

```ts
sock.on('error', (err) => {
  if (!this.connected) {
    if (!this.destroyed && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch((e) => console.error(`[orcd-client:${this.nodeName}] reconnect failed:`, (e as Error).message));
      }, 2000);
    }
    reject(err);
  } else {
    console.error(`[orcd-client:${this.nodeName}] socket error:`, err.message);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/server/orcd-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/orcd-client.ts src/server/orcd-client.test.ts
git commit -m "fix(be): retry offline node after failed initial connect"
```

---

## Phase E — BE routing & filesystem removal

Every card-routed action looks up the client by the card's node. Local worktree/path execution is replaced by protocol calls. `src/server/config/providers.ts` is deleted; `card.ts`'s contextWindow/default-provider logic moves to use the node's cached capabilities.

> **Routing helper.** All call sites that currently do `initState.getOrcdClient()` for a specific card must switch to `initState.getClientByNode(card.nodeName)`. Add a small helper in `card-sessions.ts`:
>
> ```ts
> async function clientForCard(card: { nodeName: string }): Promise<OrcdClient | null> {
>   const initState = await import('../init-state');
>   return initState.getClientByNode(card.nodeName);
> }
> ```

### Task 18: Route `startCardSession` worktree prep + create through the card's node

**Files:**
- Modify: `src/server/controllers/card-sessions.ts` (`startCardSession`, `registerAutoStart`)
- Modify: `src/server/sessions/worktree.ts` (delete local execution; keep a thin resolver or inline into startCardSession)
- Test: `src/server/controllers/card-sessions.test.ts` (find existing; add a routing test)

- [ ] **Step 1: Write the failing test**

Add a test that `startCardSession` calls `client.worktreePrepare` then `client.create` with the returned path. Use a fake client capturing calls:

```ts
it('prepares the worktree on the node then creates the session', async () => {
  const calls: string[] = [];
  const fakeClient = {
    nodeName: 'gpubox',
    worktreePrepare: async () => { calls.push('prepare'); return { path: '/repo/.worktrees/feat', branch: 'feat' }; },
    create: async (opts: { cwd: string }) => { calls.push(`create:${opts.cwd}`); return 'sess-1'; },
  };
  // card with worktreeBranch 'feat', nodeName 'gpubox', projectId set
  // invoke the exported startCardSession (export it if not already)
  // assert calls === ['prepare', 'create:/repo/.worktrees/feat']
});
```

> If `startCardSession` is not exported, export it for testability. If the existing test file mocks `ensureWorktree`, replace that with the node-routed prepare.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/controllers/card-sessions.test.ts`
Expected: FAIL — still calls local `ensureWorktree`.

- [ ] **Step 3: Rewrite `startCardSession` to prepare via the node**

```ts
async function startCardSession(client: OrcdClient, card: Card, bus: MessageBus = messageBus): Promise<string | null> {
  try {
    const { Project } = await import('../models/Project');
    const proj = card.projectId ? await Project.findOneBy({ id: card.projectId }) : null;

    let cwd: string;
    if (card.worktreeBranch && proj) {
      const source = card.sourceBranch ?? proj.defaultBranch ?? undefined;
      const res = await client.worktreePrepare({
        projectPath: proj.path,
        branch: card.worktreeBranch,
        sourceBranch: source ?? undefined,
        setupCommands: proj.setupCommands ?? '',
      });
      cwd = res.path;
    } else if (proj) {
      cwd = proj.path;
    } else {
      throw new Error(`card ${card.id} has no project`);
    }

    const prompt = card.sessionId ? '' : card.description ?? '';
    const sessionId = await client.create({
      prompt, cwd,
      provider: card.provider, model: card.model,
      sessionId: card.sessionId ?? undefined,
      contextWindow: card.contextWindow,
      summarizeThreshold: card.summarizeThreshold,
    });

    card.sessionId = sessionId;
    trackSession(card.id, sessionId);
    card.updatedAt = new Date().toISOString();
    await repo().save(card);
    console.log(`[session:${card.id}] session started: ${sessionId.slice(0, 8)} on node ${client.nodeName}`);
    return sessionId;
  } catch (err) {
    console.error(`[session:${card.id}] startCardSession error:`, err instanceof Error ? err.message : String(err));
    await markSessionStartFailed(bus, card, err);
    return null;
  }
}
```

In `registerAutoStart`, replace `const client = initState.getOrcdClient()` with:

```ts
const client = await clientForCard(card);
if (!client) {
  console.log(`[oc:auto-start] card #${card.id} node ${card.nodeName} has no client, skipping`);
  return;
}
if (!client.isConnected()) {
  console.log(`[oc:auto-start] card #${card.id} node ${card.nodeName} offline, skipping`);
  return;
}
```

Delete `src/server/sessions/worktree.ts` (its logic now lives on orcd via `worktreePrepare`). Remove its import from anywhere referencing `ensureWorktree`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/server/controllers/card-sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/controllers/card-sessions.ts
git rm src/server/sessions/worktree.ts
git commit -m "feat(be): route session start + worktree prepare through the card's node"
```

### Task 19: Route worktree cleanup through the card's node

**Files:**
- Modify: `src/server/controllers/card-sessions.ts` (`cleanupWorktreeForCard`, ~L350-375)
- Test: `src/server/controllers/card-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('removes the worktree on the card node, best-effort when offline', async () => {
  // card with worktreeBranch + projectId + nodeName
  // fake client whose worktreeRemove records the call
  // assert worktreeRemove called with (proj.path, resolvedWorktreePath)
  // second case: getClientByNode returns null → no throw
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/controllers/card-sessions.test.ts`
Expected: FAIL — cleanup still uses local `removeWorktree`.

- [ ] **Step 3: Rewrite `cleanupWorktreeForCard`**

```ts
async function cleanupWorktreeForCard(card: Card): Promise<void> {
  if (!card.worktreeBranch || !card.projectId) {
    console.log(`[oc:worktree] card ${card.id} has no worktree/project, skipping cleanup`);
    return;
  }
  try {
    const { Project } = await import('../models/Project');
    const proj = await Project.findOneBy({ id: card.projectId });
    if (!proj) {
      console.log(`[oc:worktree] card ${card.id} project not found, skipping cleanup`);
      return;
    }
    const client = await clientForCard(card);
    if (!client || !client.isConnected()) {
      console.log(`[oc:worktree] card ${card.id} node ${card.nodeName} offline, skipping cleanup (best-effort)`);
      return;
    }
    const { resolveWorkDir } = await import('../../shared/worktree');
    const wtPath = resolveWorkDir(card.worktreeBranch, proj.path);
    await client.worktreeRemove(proj.path, wtPath);
    console.log(`[oc:worktree] removed ${wtPath} on node ${card.nodeName}`);
  } catch (err) {
    console.error(`[oc:worktree] cleanup failed for card ${card.id}:`, err);
    // non-fatal
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/server/controllers/card-sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Delete `src/server/worktree.ts` and fix imports**

```bash
git rm src/server/worktree.ts
```

Search for remaining importers and remove/redirect:

Run: `grep -rn "from '../worktree'\|from './worktree'\|server/worktree" src/server | grep -v shared`
Expected: only the now-deleted references; fix any stragglers (none should remain after Tasks 18-19).

- [ ] **Step 6: Commit**

```bash
git add src/server/controllers/card-sessions.ts
git rm src/server/worktree.ts
git commit -m "feat(be): route worktree cleanup through the card's node (best-effort)"
```

### Task 20: Route `cancel`/`isActive` call sites by node

**Files:**
- Modify: `src/server/services/card.ts` (`updateCard` cancel, `deleteCard` cancel)
- Modify: `src/server/ws/handlers/agents.ts`, `src/server/ws/handlers/sessions.ts` (getOrcdClient usages)
- Test: `src/server/services/card.test.ts`

- [ ] **Step 1: Write the failing test**

In `card.test.ts`, assert that cancelling a card moving out of running uses the client for the card's node. Use a fake registry returning a per-node client.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/services/card.test.ts`
Expected: FAIL — uses `getOrcdClient()` (local only).

- [ ] **Step 3: Replace `getOrcdClient()` with node lookup at each card-scoped site**

In `card.ts` `updateCard` and `deleteCard`:

```ts
const initState = await import('../init-state');
const client = initState.getClientByNode(card.nodeName);
if (card.sessionId && client?.isActive(card.sessionId)) {
  client.cancel(card.sessionId);
}
```

In `ws/handlers/agents.ts` and `ws/handlers/sessions.ts`, for each handler that has a `card` in scope, replace `initState.getOrcdClient()` with `initState.getClientByNode(card.nodeName)`. For handlers without a card, load the card first (they already do, to get `sessionId`).

Run this to enumerate sites:

Run: `grep -rn "getOrcdClient" src/server`
Expected: only non-card-scoped/global usages remain (none should — all are card-scoped). Replace every one.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/server/services/card.test.ts src/server/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/services/card.ts src/server/ws/handlers/agents.ts src/server/ws/handlers/sessions.ts
git commit -m "feat(be): route cancel/isActive by card node"
```

### Task 21: Replace `config/providers.ts` with node capability lookups in `card.ts`

**Files:**
- Modify: `src/server/services/card.ts`
- Delete: `src/server/config/providers.ts`
- Test: `src/server/services/card.test.ts`

- [ ] **Step 1: Write the failing test**

Assert `createCard` derives `contextWindow` from the project's node capabilities (fake client with `capabilities.providers[].models[].contextWindow`). For a project with `nodeName='gpubox'`, provider `anthropic`, model `sonnet` (contextWindow 1_000_000), expect `card.contextWindow === 1_000_000`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/services/card.test.ts`
Expected: FAIL — still imports `getModelConfig` from deleted module (or uses local config).

- [ ] **Step 3: Add a capability lookup helper + use it in `createCard`**

Add to `src/server/config/nodes.ts` (or a new `capabilities.ts`):

```ts
import { getClientByNode } from '../init-state';

export function contextWindowFor(nodeName: string, provider: string, modelAlias: string): number | undefined {
  const caps = getClientByNode(nodeName)?.capabilities;
  const p = caps?.providers.find((x) => x.id === provider);
  return p?.models.find((m) => m.alias === modelAlias)?.contextWindow;
}

export function defaultProviderFor(nodeName: string): string | undefined {
  return getClientByNode(nodeName)?.capabilities?.defaults.provider;
}
```

> Note: `init-state` is dynamically imported elsewhere to survive Vite restarts. Import it normally here — `capabilities.ts` is only reached at request time, not at module load by `vite.config.ts`. Verify no static import chain from `vite.config.ts` reaches this file; if it does, switch to a dynamic import inside the functions.

In `card.ts`, remove `import { getDefaultProviderID, getModelConfig } from '../config/providers'`. In `createCard`, replace the provider/contextWindow logic:

```ts
// Inherit defaults from project if projectId set
let providerID: string | undefined;
let nodeName = 'local';
if (data.projectId) {
  const proj = await Project.findOneBy({ id: data.projectId });
  if (proj) {
    nodeName = proj.nodeName ?? 'local';
    providerID = proj.providerID ?? undefined;
    data.model = data.model ?? proj.defaultModel;
    data.thinkingLevel = data.thinkingLevel ?? proj.defaultThinkingLevel;
    if (proj.defaultWorktree && !data.worktreeBranch && data.title) {
      const { slugify } = await import('../../shared/worktree');
      data.worktreeBranch = slugify(data.title);
    }
    data.sourceBranch = data.sourceBranch ?? proj.defaultBranch;
  }
}
const { contextWindowFor, defaultProviderFor } = await import('../config/capabilities');
providerID = providerID ?? defaultProviderFor(nodeName) ?? 'anthropic';
data.provider = data.provider ?? providerID;
data.nodeName = nodeName;
data.summarizeThreshold = data.summarizeThreshold ?? 0.6;

const cw = contextWindowFor(nodeName, providerID, data.model ?? 'sonnet');
if (cw) data.contextWindow = cw;
```

Update `updateCard`'s contextWindow refresh similarly (`contextWindowFor(card.nodeName, providerID, model)`).

Delete the old module:

```bash
git rm src/server/config/providers.ts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/server/services/card.test.ts`
Expected: PASS

- [ ] **Step 5: Fix remaining importers of `config/providers`**

Run: `grep -rn "config/providers" src app`
Expected: only `ws/handlers/projects.ts` (sync payload — handled in Task 25). For any others, redirect to `capabilities.ts` or the node catalog.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/card.ts src/server/config/capabilities.ts
git rm src/server/config/providers.ts
git commit -m "feat(be): derive provider/contextWindow from node capabilities"
```

### Task 22: Route `path_validate` in project create/update

**Files:**
- Modify: `src/server/services/project.ts`
- Test: `src/server/services/project.test.ts`

- [ ] **Step 1: Write the failing test**

Assert that creating a project validates its path against the project's node (`getClientByNode(nodeName).pathValidate(path)`), setting `isGitRepo`/`defaultBranch` from the reply. Use a fake client.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/server/services/project.test.ts`
Expected: FAIL — still uses local `existsSync`.

- [ ] **Step 3: Replace local fs checks with `pathValidate`**

In `src/server/services/project.ts`, where it does `data.isGitRepo = existsSync(join(data.path, '.git'))`:

```ts
const initState = await import('../init-state');
const client = initState.getClientByNode(data.nodeName ?? 'local');
if (!client || !client.isConnected()) {
  throw new Error(`node ${data.nodeName ?? 'local'} is offline; cannot validate project path`);
}
const v = await client.pathValidate(data.path);
data.isGitRepo = v.isGitRepo;
if (v.isGitRepo && !data.defaultBranch && v.defaultBranch) data.defaultBranch = v.defaultBranch;
if (!v.exists) throw new Error(`path does not exist on node ${data.nodeName ?? 'local'}: ${data.path}`);
```

Apply to both create and the path-change branch in update. Remove the `existsSync`/`join` imports if now unused.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/server/services/project.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/services/project.ts
git commit -m "feat(be): validate project path on its node"
```

---

## Phase F — data model

Add immutable `node_name` to `projects` and `cards`, backfilled to `'local'`. Schema additions go through the sqlite3 CLI per the project's DB guardrails (`ALTER TABLE ADD COLUMN` is safe anytime; never run WAL/checkpoint commands).

### Task 23: Add `node_name` columns to the DB and entities

**Files:**
- Modify: `src/server/models/Project.ts`
- Modify: `src/server/models/Card.ts`
- DB: `data/orchestrel.db` (ALTER TABLE)

- [ ] **Step 1: Apply the schema additions**

```bash
sqlite3 data/orchestrel.db "ALTER TABLE projects ADD COLUMN node_name TEXT NOT NULL DEFAULT 'local';"
sqlite3 data/orchestrel.db "ALTER TABLE cards ADD COLUMN node_name TEXT NOT NULL DEFAULT 'local';"
sqlite3 data/orchestrel.db "SELECT name FROM pragma_table_info('cards') WHERE name='node_name';"
```

Expected: prints `node_name`.

- [ ] **Step 2: Add the entity columns**

In `src/server/models/Project.ts`, add near `providerID`:

```ts
  @Column({ name: 'node_name', type: 'text', default: 'local' })
  nodeName!: string;
```

In `src/server/models/Card.ts`, add near `provider`:

```ts
  @Column({ name: 'node_name', type: 'text', default: 'local' })
  nodeName!: string;
```

- [ ] **Step 3: Snapshot the node onto the card at creation**

This was already wired in Task 21 (`data.nodeName = nodeName`). Confirm `createCard` sets `data.nodeName` from the project (defaulting `'local'` when no project). No code change if Task 21 is complete; otherwise add it.

- [ ] **Step 4: Verify the app boots and reads cards**

Run: `pnpm test src/server/services/card.test.ts src/server/services/project.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/models/Project.ts src/server/models/Card.ts
git commit -m "feat(db): add immutable node_name to projects and cards"
```

### Task 24: Expose `nodeName` on the FE wire types

**Files:**
- Modify: `src/shared/ws-protocol.ts` (Card/Project zod schemas + types)
- Test: existing ws-protocol tests

- [ ] **Step 1: Add `nodeName` to the Card and Project schemas**

In `src/shared/ws-protocol.ts`, add `nodeName: z.string()` to the `projectCreateSchema`/`Project` and `Card` schemas (match the existing field style; make it optional on create input with a `'local'` default if creation input shouldn't require it):

```ts
// on the Card schema:
nodeName: z.string().default('local'),
// on the Project schema / projectCreateSchema:
nodeName: z.string().default('local'),
```

- [ ] **Step 2: Run the protocol tests**

Run: `pnpm test src/shared/ws-protocol.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/ws-protocol.ts
git commit -m "feat(protocol): expose nodeName on Card/Project wire types"
```

---

## Phase G — FE

The sync payload becomes node-aware (which nodes exist, their connection state, per-node capabilities). The project form picks a node first; cards inherit it read-only; cards on offline nodes render read-only from cache.

### Task 25: Node-aware sync payload

**Files:**
- Modify: `src/shared/ws-protocol.ts` (`SyncPayload`)
- Modify: `src/server/ws/handlers/projects.ts` (~L56 sync emit)
- Test: a server-side test asserting the payload shape (extend an existing handler test or add one)

- [ ] **Step 1: Define the nodes payload type**

In `src/shared/ws-protocol.ts`, add:

```ts
export interface NodeInfo {
  name: string;
  connected: boolean;
  providers: Record<string, ProviderConfig>; // empty when offline
  defaults?: { provider: string; model: string };
}
```

Change `SyncPayload`:

```ts
export interface SyncPayload {
  cards: Card[];
  projects: Project[];
  nodes: NodeInfo[];          // replaces the flat `providers` map
  user?: User;
  users?: User[];
}
```

- [ ] **Step 2: Build the nodes payload from the registry + clients**

Add a helper in `src/server/config/capabilities.ts`:

```ts
import { listNodeClients } from '../init-state';
import type { NodeInfo, ProviderConfig } from '../../shared/ws-protocol';

export function nodesForClient(): NodeInfo[] {
  return listNodeClients().map((c) => {
    const caps = c.capabilities;
    const providers: Record<string, ProviderConfig> = {};
    if (caps) {
      for (const p of caps.providers) {
        providers[p.id] = {
          label: p.label,
          models: Object.fromEntries(p.models.map((m) => [m.alias, { label: m.label, modelID: m.alias, contextWindow: m.contextWindow }])),
        };
      }
    }
    return { name: c.nodeName, connected: c.isConnected(), providers, ...(caps ? { defaults: caps.defaults } : {}) };
  });
}
```

> `modelID` isn't known to the BE (orcd hides it); the FE only needs alias/label/contextWindow for selection, so reuse the alias as `modelID` placeholder. If any FE code relies on a real `modelID`, drop that dependency — the BE no longer routes by modelID.

In `src/server/ws/handlers/projects.ts`, replace `providers: getProvidersForClient()` with `nodes: nodesForClient()` (import from `capabilities.ts`); remove the `getProvidersForClient` import.

- [ ] **Step 3: Run the handler/protocol tests**

Run: `pnpm test src/server/ws src/shared/ws-protocol.test.ts`
Expected: PASS (update any test asserting the old `providers` field).

- [ ] **Step 4: Commit**

```bash
git add src/shared/ws-protocol.ts src/server/ws/handlers/projects.ts src/server/config/capabilities.ts
git commit -m "feat(fe-wire): node-aware sync payload"
```

### Task 26: FE config store holds nodes

**Files:**
- Modify: `app/stores/config-store.ts`
- Modify: caller that hydrates sync (find where `SyncPayload` is consumed — likely `app/stores/*` board store)
- Test: `app/stores/config-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('hydrates nodes and exposes connected ones', () => {
  const store = new ConfigStore();
  store.hydrateNodes([
    { name: 'local', connected: true, providers: { anthropic: { label: 'Anthropic', models: { sonnet: { label: 'Sonnet', modelID: 'sonnet', contextWindow: 1000000 } } } }, defaults: { provider: 'anthropic', model: 'sonnet' } },
    { name: 'gpubox', connected: false, providers: {} },
  ]);
  expect(store.nodes.length).toBe(2);
  expect(store.connectedNodes.map((n) => n.name)).toEqual(['local']);
  expect(store.providersForNode('local').anthropic.label).toBe('Anthropic');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app/stores/config-store.test.ts`
Expected: FAIL — `hydrateNodes`/`nodes`/`connectedNodes`/`providersForNode` missing.

- [ ] **Step 3: Implement node state in `ConfigStore`**

```ts
import type { NodeInfo, ProviderConfig, ModelConfig } from '../../src/shared/ws-protocol';

export class ConfigStore {
  nodes: NodeInfo[] = [];
  constructor() { makeAutoObservable(this); }

  hydrateNodes(nodes: NodeInfo[]) { this.nodes = nodes; }

  get connectedNodes(): NodeInfo[] { return this.nodes.filter((n) => n.connected); }

  nodeByName(name: string): NodeInfo | undefined { return this.nodes.find((n) => n.name === name); }

  providersForNode(name: string): Record<string, ProviderConfig> { return this.nodeByName(name)?.providers ?? {}; }

  getModelsForNode(name: string, providerID: string): [string, ModelConfig][] {
    return Object.entries(this.providersForNode(name)[providerID]?.models ?? {});
  }

  defaultModelForNode(name: string, providerID: string): string {
    const keys = Object.keys(this.providersForNode(name)[providerID]?.models ?? {});
    return keys[0] ?? 'sonnet';
  }
}
```

Keep the old `providers`-based methods only if other components still call them; otherwise remove. Update the sync-consumer to call `config.hydrateNodes(payload.nodes)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test app/stores/config-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/stores/config-store.ts app/stores/*.ts
git commit -m "feat(fe): config store tracks nodes + per-node capabilities"
```

### Task 27: Project form picks a node, constrains provider/model, validates path on node

**Files:**
- Modify: `app/components/ProjectForm.tsx`
- Modify: `app/stores/project-store.ts` (if it carries provider/model lists)

- [ ] **Step 1: Add node selection state**

Add `const [nodeName, setNodeName] = useState(project?.nodeName ?? config.connectedNodes[0]?.name ?? 'local')`. Render a Node `<Select>` (first field) listing `config.connectedNodes`. Disable provider/model/path until a node is chosen.

- [ ] **Step 2: Constrain provider/model to the node**

Replace `config.allProviders` with `Object.entries(config.providersForNode(nodeName))`; replace `config.getModels(providerID)` with `config.getModelsForNode(nodeName, providerID)`; replace `config.getDefaultModel` in `handleProviderChange` with `config.defaultModelForNode(nodeName, newProvider)`. When `nodeName` changes, reset provider/model to that node's defaults.

- [ ] **Step 3: Include `nodeName` in the submitted payload**

Add `nodeName` to the object passed to the create/update handler (alongside `path`, `providerID`, `defaultModel`).

- [ ] **Step 4: Manual verification**

Build and load the dev UI; create a project on `local`, confirm provider/model lists come from the node and the project saves with `node_name='local'`. (No unit test — this is a wiring/UI change; covered by Task 22's server-side path_validate test + manual check.)

Run: `pnpm build`
Expected: builds without type errors.

- [ ] **Step 5: Commit**

```bash
git add app/components/ProjectForm.tsx app/stores/project-store.ts
git commit -m "feat(fe): project form is node-aware"
```

### Task 28: Offline-node card is read-only

**Files:**
- Modify: card detail / session view components (find the component rendering card actions — `app/components/CardDetail.tsx` / `SessionView`)
- Modify: card create form (inherit project node, show non-editable)

- [ ] **Step 1: Compute node-offline state per card**

In the card detail component, derive `const node = config.nodeByName(card.nodeName); const nodeOffline = !node?.connected;`.

- [ ] **Step 2: Gate interactions on `nodeOffline`**

When `nodeOffline`: show a "node offline / reconnecting" badge; disable the message input, send button, cancel, and effort controls; still render the transcript (it paints from the FE conversation cache as today). Do not tear down or move the card.

- [ ] **Step 3: Card create inherits project node, non-editable**

In the card create form, set the card's node from the selected project; render it as a read-only label (not a selector).

- [ ] **Step 4: Manual verification**

Run: `pnpm build`
Expected: builds. Manually: stop a node's orcd, confirm its cards show offline + disabled actions while the transcript still renders from cache.

- [ ] **Step 5: Commit**

```bash
git add app/components/
git commit -m "feat(fe): offline-node cards render read-only from cache"
```

---

## Phase H — integration

### Task 29: Two-orcd integration test

**Files:**
- Test: `src/server/__tests__/multi-node.integration.test.ts` (create)

- [ ] **Step 1: Write the integration test**

Boot two `OrcdServer` instances on two `127.0.0.1` ports (standing in for two boxes), each with its own token and a temp git repo. Create two `OrcdClient`s, `sayHello` to each, and assert:

```ts
import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrcdServer } from '../../orcd/socket-server';
import { OrcdClient } from '../orcd-client';

async function tempRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'multi-node-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('multi-node isolation', () => {
  const cleanup: Array<() => void> = [];
  afterAll(async () => { for (const c of cleanup) c(); });

  it('two nodes report independent capabilities and prepare worktrees independently', async () => {
    const a = new OrcdServer({ listen: { host: '127.0.0.1', port: 7811 }, authToken: 'a-tok', name: 'nodeA' },
      { anthropic: { type: 'anthropic', label: 'Anthropic', baseUrl: '', apiKey: '', models: ['claude-sonnet-4-6'], modelLabels: { 'claude-sonnet-4-6': { alias: 'sonnet', label: 'Sonnet', contextWindow: 1000000 } }, modelAliasEnv: {} } },
      { provider: 'anthropic', model: 'sonnet' });
    const b = new OrcdServer({ listen: { host: '127.0.0.1', port: 7812 }, authToken: 'b-tok', name: 'nodeB' },
      { bedrock: { type: 'anthropic', label: 'Bedrock', baseUrl: '', apiKey: '', models: ['m'], modelLabels: { m: { alias: 'haiku', label: 'Haiku', contextWindow: 200000 } }, modelAliasEnv: {} } },
      { provider: 'bedrock', model: 'haiku' });
    await a.start(); await b.start();
    cleanup.push(() => a.stop(), () => b.stop());

    const ca = new OrcdClient({ host: '127.0.0.1', port: 7811, token: 'a-tok', name: 'nodeA' });
    const cb = new OrcdClient({ host: '127.0.0.1', port: 7812, token: 'b-tok', name: 'nodeB' });
    await ca.connect(); await cb.connect();
    cleanup.push(() => ca.disconnect(), () => cb.disconnect());

    expect(ca.capabilities?.name).toBe('nodeA');
    expect(cb.capabilities?.name).toBe('nodeB');
    expect(ca.capabilities?.providers[0].id).toBe('anthropic');
    expect(cb.capabilities?.providers[0].id).toBe('bedrock');

    const repoA = await tempRepo();
    cleanup.push(() => { void rm(repoA, { recursive: true, force: true }); });
    const wt = await ca.worktreePrepare({ projectPath: repoA, branch: 'feat-a', setupCommands: '' });
    expect(wt.path).toBe(join(repoA, '.worktrees', 'feat-a'));
  });

  it('rejects a client presenting the wrong token', async () => {
    const a = new OrcdServer({ listen: { host: '127.0.0.1', port: 7813 }, authToken: 'right', name: 'nodeA' },
      { anthropic: { type: 'anthropic', label: 'A', baseUrl: '', apiKey: '', models: ['m'], modelLabels: { m: { alias: 'sonnet', label: 'S', contextWindow: 1 } }, modelAliasEnv: {} } },
      { provider: 'anthropic', model: 'sonnet' });
    await a.start();
    cleanup.push(() => a.stop());
    const c = new OrcdClient({ host: '127.0.0.1', port: 7813, token: 'wrong', name: 'nodeA' });
    await expect(c.connect()).rejects.toBeTruthy();
    c.disconnect();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm test src/server/__tests__/multi-node.integration.test.ts`
Expected: PASS

- [ ] **Step 3: Full suite**

Run: `pnpm test`
Expected: PASS (whole suite green).

- [ ] **Step 4: Commit**

```bash
git add src/server/__tests__/multi-node.integration.test.ts
git commit -m "test: two-orcd multi-node integration"
```

---

## Phase I — resilience tuning

The spec's resilience strategy is: size the per-session ring buffer to cover the max expected BE↔node outage (no JSONL rehydration in v1). The buffer currently defaults to 1000 events with no way to configure it.

### Task 30: Make the session ring-buffer size configurable

**Files:**
- Modify: `src/shared/config.ts` (parse `ringBufferSize`)
- Modify: `src/orcd/config.ts` (carry it onto `OrcdConfig`)
- Modify: `src/orcd/socket-server.ts` (pass to `OrcdSession` at both construction sites, L145 + L270)
- Modify: `src/orcd/index.ts` (thread the value into the server) OR pass via the providers/defaults — simplest: add a field to `OrcdServer` opts
- Test: `src/orcd/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/orcd/__tests__/config.test.ts`, add to a parse test:

```ts
it('parses ringBufferSize with a default', () => {
  const cfg = parseConfig(`
listen: { host: 127.0.0.1, port: 7420 }
authToken: tok
defaultProvider: anthropic
defaultModel: sonnet
providers:
  anthropic:
    label: Anthropic
    models:
      sonnet: { label: "Sonnet", modelID: claude-sonnet-4-6, contextWindow: 200000 }
`, {});
  expect(cfg.ringBufferSize).toBe(5000); // default
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/orcd/__tests__/config.test.ts`
Expected: FAIL — `ringBufferSize` not present.

- [ ] **Step 3: Parse and thread it**

In `src/shared/config.ts`, add `ringBufferSize: number;` to `OrchestrelConfig` and parse `ringBufferSize: Number(raw.ringBufferSize ?? 5000)` (default 5000 — ~5x the old default, covering longer outages cheaply since events are small in-memory objects).

In `src/orcd/config.ts`, add `ringBufferSize: number` to `OrcdConfig` and pass `ringBufferSize: cfg.ringBufferSize` in `toOrcdShape`.

In `src/orcd/socket-server.ts`, add `ringBufferSize?: number` (optional, so the auth/capabilities/integration tests that construct `OrcdServer` without it still type-check) to the `OrcdListenConfig` opts, and pass `bufferSize: this.opts.ringBufferSize` into both `new OrcdSession({ ... })` sites (L145, L270). `OrcdSession` already defaults `bufferSize ?? 1000`, so an undefined value is safe; the configured default of 5000 flows in from `index.ts`.

In `src/orcd/index.ts`, include `ringBufferSize: config.ringBufferSize` in the `OrcdServer` opts object.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/orcd/__tests__/config.test.ts src/orcd/`
Expected: PASS

- [ ] **Step 5: Document the knob in `orcd.example.yaml`**

Add under `defaultCwd`:

```yaml
ringBufferSize: 5000   # per-session event buffer; size to cover the max expected BE↔node outage
```

- [ ] **Step 6: Commit**

```bash
git add src/shared/config.ts src/orcd/config.ts src/orcd/socket-server.ts src/orcd/index.ts src/orcd/__tests__/config.test.ts orcd.example.yaml
git commit -m "feat(orcd): configurable session ring-buffer size for outage tolerance"
```

---

## Final verification

- [ ] Run `pnpm test` — full suite green.
- [ ] Run `pnpm build` — production build succeeds.
- [ ] Manual smoke: local node (`127.0.0.1:7420`) connects, a card runs end-to-end (worktree prepared on the node, agent spawns, events stream, session_exit moves card to review).
- [ ] Manual smoke: stop the node's orcd; confirm its cards show offline + read-only and the BE keeps retrying; restart orcd and confirm reconnect + event replay.
- [ ] Confirm `config.yaml`→`orcd.yaml` and `orc.yaml` exist locally (gitignored); `orcd.example.yaml` + `orc.example.yaml` committed.

## Migration runbook (operator)

1. On the box: rename `config.yaml`→`orcd.yaml`; remove `socket:`; add `listen:`, `authToken:`, `name:`.
2. On the BE: create `orc.yaml` with one `local` server at `127.0.0.1:7420` and the matching token.
3. DB: the two `ALTER TABLE ... ADD COLUMN node_name` statements (Task 23) — safe anytime.
4. Restart orcd, then the BE (`sudo systemctl restart orchestrel`).
5. Add remote nodes by appending to `orc.yaml` (and installing/configuring orcd on each box) and restarting the BE.
