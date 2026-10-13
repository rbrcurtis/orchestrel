# Self-Contained Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the thin `desktop/` Electron wrappers with a single self-contained app (Linux, macOS, Windows) that bundles the React client, backend, orcd, and its own Kiro proxy, auto-updating from GitHub Releases.

**Architecture:** Electron main process is a pure supervisor: it seeds a `userData` tree on first run, then spawns three coprocesses on a bundled plain-Node binary — KPP (`kpp.bundle.mjs serve`), orcd (`orcd.bundle.mjs`), backend (`server.bundle.mjs`) — waits for the backend's HTTP to answer, then opens a BrowserWindow at `127.0.0.1:<port>`. Bundles are produced by an esbuild step from the existing TS sources; KPP sources come from the sibling `kiro-pool-proxy` repo pinned at build time.

**Tech Stack:** Electron 44, electron-builder 26, electron-updater, esbuild, vitest; existing stack: Express, socket.io, TypeORM + better-sqlite3, `@earendil-works/pi-coding-agent`, `kiro-pool-proxy` (plain Node + SQLite + AWS OIDC).

**Spec:** `docs/specs/2026-10-13-desktop-app-design.md`

## Global Constraints

- Kiro is the only provider in v1; no Anthropic/Claude Max, no remote orcd nodes, no wizards, no in-app auth UI.
- All three service bundles run on **plain Node** (bundled `resources/node`), never Electron's Node ABI. The Electron main process must therefore **never import `better-sqlite3`** (or any native module) — DB seeding happens in the backend, not in main.
- No `any` (TS strict). No dependency injection; services read env/files directly. Comments are decision records only.
- All per-user state under `app.getPath('userData')` — nothing in `~/.config/kiro-auth` or the user's `~/.orc`.
- Kiro auth is CLI-only: `orchestrel kiro <login|status|logout|refresh>`; the shim is installed to `~/.local/bin` idempotently and repaired on every launch.
- One version number in `desktop/package.json`; it stamps the GitHub Release and `latest*.yml` feed.
- Bash scripts: `set -ex`, single-purpose.
- Backend/orcd/KPP code paths must keep working for the hosted deployment unchanged — every backend touch is an env-var override with the current default.

## Review Focus

- **ABI leak:** the Electron main process importing a native module (e.g. better-sqlite3) loads against Electron's ABI and crashes or corrupts. Expect: app never starts on any platform. Pinned in Task 6 (import-scan test over `desktop/main/` + `desktop/lib/`).
- **userData paths with spaces or `$`** (e.g. `/home/user/my data/Orchestrel`): child spawn env/cwd must be quoted through Node's `spawn` array form, and the CLI shim script must quote every path. Expect: children fail to start only on some users' machines. Pinned in Task 1 and Task 5 tests.
- **Respawn storm:** a persistently crashing child must not be restarted forever. Expect: rate limit trips, error window shows, no CPU spin. Pinned in Task 1 tests.
- **Second app instance on the same machine** opening the same userData: single-instance lock; the second launch focuses the existing window instead of spawning a second stack. Manual (Task 6 checklist).
- **Kiro device-code expiry** mid-login (code valid ~5 min): CLI surfaces AWS's expiry error verbatim, account is not half-written. Manual (Task 8 checklist).

---

### Task 1: Desktop package foundation + supervisor core

Rewrite `desktop/` as the self-contained app package, and build the supervisor as a pure Node module (no Electron imports) so it is unit-testable.

**Files:**
- Delete: `desktop/src/`, `desktop/assets/`, `desktop/electron-builder.orc-chat.yml`, `desktop/electron-builder.orchestrel.yml`, `desktop/README.md`
- Create: `desktop/package.json`, `desktop/tsconfig.json`
- Create: `desktop/lib/supervisor.ts` — child process supervision (no Electron imports)
- Create: `desktop/lib/supervisor.test.ts`
- Create: `desktop/lib/bootstrap.ts` — reads/writes `bootstrap.json` (no Electron imports)
- Test: `desktop/lib/supervisor.test.ts`, `desktop/lib/bootstrap.test.ts`

**Interfaces:**
- Produces (used by Tasks 2, 6, 7):
  - `interface ServiceDef { id: 'kpp' | 'orcd' | 'backend'; command: string; args: string[]; env: Record<string, string>; cwd: string }`
  - `interface Spawned extends ServiceDef { proc: ChildProcessWithoutNullStreams }`
  - `interface SupervisorOptions { logDir: string; healthUrl: string; spawn?: (command: string, args: string[], opts: { env: Record<string,string>; cwd: string }) => ChildProcessWithoutNullStreams }` (spawn override is used by production AND tests alike — it changes environments: electron's app dir vs test fixture dirs; tests also use it to simulate crashes, which production exercises too, so it is a real seam)
  - `class Supervisor { constructor(opts: SupervisorOptions): void; start(defs: ServiceDef[]): Promise<void>; stop(): Promise<void>; on(event: 'crash', cb: (svc: ServiceDef, logTail: string, gaveUp: boolean) => void): void }`
  - Respawn policy constants (exported for tests): `MAX_RESPAWNS = 5`, `RESPAWN_WINDOW_MS = 5 * 60_000`.
  - `writeBootstrap(dir: string, data: BootstrapData): void`, `readBootstrap(dir: string): BootstrapData`, `interface BootstrapData { backendPort: number; kppPort: number; orcdPort: number; authToken: string }`
- Consumes: nothing beyond `node:*` builtins.

- [ ] **Step 1: Write the failing supervisor tests**

`desktop/lib/supervisor.test.ts` (vitest, plain node env):
- `test('starts services in the order given and gates on the health url')` — fake spawn returns stub procs; supervisor must not resolve `start()` until `healthUrl` answers 200; assert start order array equals input order. Health: stand up a tiny `http.createServer` in the test on an ephemeral port, respond 200 only after a flag flips; flip it when the third proc is "started".
- `test('respawns a crashed service within the rate window')` — kill one fake proc (emit `'exit'` code 1); assert a new spawn happens for that `id` only.
- `test('gives up after MAX_RESPAWNS exits within RESPAWN_WINDOW_MS and emits crash with log tail')` — kill one fake proc 6 times rapidly; assert no further spawn and the `crash` callback fired with `gaveUp: true` and a non-empty `logTail` (the fake proc writes to its fake log fd).
- `test('stop() kills all children and drains stdio')` — `stop()` resolves only after all 3 procs emit exit; assert kill called on each exactly once.
- `test('spawns with array args — paths with spaces are not word-split')` — fake spawn records its args; service def with `cwd: '/tmp/a b'` and an arg containing a space arrives verbatim.

`desktop/lib/bootstrap.test.ts`:
- `test('writeBootstrap/readBootstrap roundtrip')` — write to a `fs.mkdtemp` dir, read back, deep-equal; also `test('writeBootstrap is atomic — no partial file on concurrent read')` is dropped (YAGNI); instead `test('readBootstrap throws with a readable message when missing')`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && npm install && npx vitest run lib`
Expected: FAIL — `desktop/lib/supervisor.ts` does not exist.

- [ ] **Step 3: Create the desktop package scaffold**

`desktop/package.json`: name `orchestrel-desktop`, version `1.0.0` (single source of truth for the app version), private, `"main": "dist/main.cjs"`, devDependencies: `electron ^44`, `electron-builder ^26`, `electron-updater`, `esbuild ^0.25`, `typescript ^5`, `vitest`, `concurrently` (drop from the old package: nothing is reused). Scripts:
- `"dev": "npm run bundles && ORCHESTREL_NODE=$(pwd)/node electron ."` — placeholder until Task 4/6; keep `bundles` as a no-op stub script in this task, replaced in Task 4.
- `"test": "vitest run"`, `"typecheck": "tsc -b"`.

`desktop/tsconfig.json`: strict, `module: NodeNext`, `target: ES2022`, include `lib` and `main` (noEmit; esbuild handles emit in Task 4).

- [ ] **Step 4: Implement `desktop/lib/bootstrap.ts` and `desktop/lib/supervisor.ts`**

`bootstrap.ts`: JSON file at `<dir>/bootstrap.json`; `writeBootstrap` writes `JSON.stringify(data, null, 2)`.

`supervisor.ts`:
- `start(defs)`: for each def in order, `spawn(def.command, def.args, { env, cwd })`, pipe `stdout`/`stderr` into `<logDir>/<id>.log` (append), track `Spawned`. After all spawned, poll `healthUrl` every 250 ms until non-connection-error response (any status ≥ 0 counts — the SPA returns 200; socket.io attach is not required for window display), timeout 60 s → throw with the backend log tail attached.
- Child `'exit'`: within the rate window for that `id` (counting only exits inside `RESPAWN_WINDOW_MS`), spawn a replacement with the same def; when the count exceeds `MAX_RESPAWNS`, stop respawning that `id` and emit `crash` with `gaveUp: true`, `logTail` = last 100 lines of its log file.
- `stop()`: SIGTERM all, wait up to 5 s for exits, SIGKILL stragglers, resolve.
- Log tail helper: read last 100 lines of `<logDir>/<id>.log`, tolerate missing file (return '').

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd desktop && npx vitest run lib && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A desktop/
git commit -m "feat(desktop): self-contained app package foundation + supervisor core"
```

---

### Task 2: First-run seeding + default user

Seed the `userData` tree (configs only — no DB writes in main) and make the backend seed its single local user.

**Files:**
- Create: `desktop/lib/seed.ts`, `desktop/lib/seed.test.ts`
- Modify: `src/server/models/index.ts` (or the `initDatabase` function it exports) — seed a local user when the `users` table is empty
- Test: `desktop/lib/seed.test.ts`, extend the backend model tests (`src/server/models/__tests__` or wherever `initDatabase` is currently tested)

**Interfaces:**
- Produces:
  - `interface SeedPorts { backendPort: number; kppPort: number; orcdPort: number }`
  - `pickFreePorts(count: number): Promise<number[]>` (binds a `net.Server` to port 0, closes, returns the ports)
  - `seedUserData(userDataDir: string): Promise<{ seeded: boolean; ports: SeedPorts; authToken: string }>` — no-op (returns existing `bootstrap.json` data) when `bootstrap.json` exists.
- Consumes: `writeBootstrap` / `readBootstrap` / `BootstrapData` from Task 1.

Seeded files (written when missing, exact shapes):
- `userData/orcd.yaml` — `listen: {host: 127.0.0.1, port: <orcdPort>}`, `authToken: <token>`, `name: local`, `defaultProvider: kiro`, `defaultModel: auto`, `ringBufferSize: 5000`, `maintainers: false`, and one provider:
  ```yaml
  providers:
    kiro:
      label: Kiro
      baseUrl: http://127.0.0.1:<kppPort>
      apiKey: local
      models:
        auto: { modelID: auto, label: Auto, contextWindow: 180000 }
  ```
  (Match the field names `src/orcd/config.ts` `parseConfig`/`toOrcdShape` actually accept — verify against `src/shared/config.ts` `OrchestrelConfig` while implementing; the shape above is the flattened orcd shape, use whatever `ORC_CONFIG`'s file format is.)
- `userData/orc.yaml` — `servers: [{ name: local, host: 127.0.0.1, port: <orcdPort>, authToken: <token> }]` (shape per `parseNodeRegistry` in `src/server/config/nodes.ts`).
- `userData/kiro/config.json` — KPP config: `pools: { local: <one pool entry copied from kiro-pool-proxy config.example.json, values left as defaults> }`, `dbPath: <userData>/kiro/accounts.db`, `port: <kppPort>`, `host: 127.0.0.1` (exact keys per `kiro-pool-proxy/src/lib/config.ts`).
- `userData/bootstrap.json` via `writeBootstrap`.
- Directories created: `userData/data/`, `userData/logs/`, `userData/kiro/`.
- Token: `randomUUID()`.

Backend change: in `initDatabase`, after `AppDataSource.initialize()`, `INSERT` one user row (email `local@orchestrel.local`, role `admin` — check the `users` table columns and the role values the rest of the code actually checks) when the table is empty; idempotent, wrapped so a pre-existing row (hosted deployments) is untouched.

- [ ] **Step 1: Write the failing seed tests**

`desktop/lib/seed.test.ts` (mkdtemp fixtures):
- `test('seeds all five artifacts and the three directories on first run')` — call `seedUserData(tmp)`, assert `seeded: true`; assert each file parses (yaml/json) and cross-file consistency: `orcd.yaml.authToken === orc.yaml.servers[0].authToken === bootstrap.authToken`, `orcd.yaml.listen.port === bootstrap.orcdPort`, `orc.yaml.servers[0].port === bootstrap.orcdPort`, kiro config `dbPath` under `tmp/kiro/`, kiro config `port === bootstrap.kppPort`.
- `test('second call is a no-op returning the stored bootstrap')` — mutate nothing; call twice, second returns `seeded: false` and identical data; mtime of `orcd.yaml` unchanged (stat before/after).
- `test('picked ports are distinct and not zero')`.

Backend test (in the existing model test file's style): `test('initDatabase seeds a local admin user when users table is empty')` and `test('initDatabase leaves existing users untouched')` — use the same in-memory/temp-DB pattern the existing model tests use.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && npx vitest run lib/seed.test.ts`; root: `npx vitest run src/server/models`
Expected: FAIL — `seedUserData` undefined; backend user absent.

- [ ] **Step 3: Implement `desktop/lib/seed.ts`**

- `pickFreePorts`: sequential bind-to-0 loop.
- `seedUserData`: read existing bootstrap if present → return it; else pick ports, token, write files (use `js-yaml` from the root repo — hoisted; add as desktop devDependency if resolution is awkward) and dirs, `writeBootstrap`, return.

- [ ] **Step 4: Implement the backend user seed in `initDatabase`**

One guarded block after `initialize()`. Update the existing backend tests' expectations only if the empty-DB fixture asserts user count.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd desktop && npx vitest run lib`; root: `npx vitest run src/server/models`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add desktop/lib src/server/models
git commit -m "feat(desktop): first-run userData seeding + local user seed"
```

---

### Task 3: KPP_CONFIG env override (kiro-pool-proxy repo)

Make KPP's config path overridable so the bundled app can point at `userData/kiro/config.json` without touching the user's real KPP install.

**Files:**
- Modify: `/home/ryan/Code/kiro-pool-proxy/src/lib/config.ts` (`loadConfig` — `process.env.KPP_CONFIG` wins over the `__dirname`-relative path)
- Test: `/home/ryan/Code/kiro-pool-proxy/src/lib/config.test.ts` (create if absent, matching the repo's existing test layout)

**Interfaces:**
- Produces: `KPP_CONFIG` env var consumed by the desktop build (Tasks 4, 5) and by `serve`.

- [ ] **Step 1: Write the failing test**

`test('KPP_CONFIG env var overrides the default config path')` — write a temp `config.json` (minimal: `pools: {}`, valid shape), set `process.env.KPP_CONFIG`, clear the module's cache (the repo's `loadConfig` has a `cached` memo — export a test-visible reset or re-spawn the module; follow whatever pattern that repo's existing tests use), `expect(loadConfig().port).toBe(<value from temp file>)`. Restore `delete process.env.KPP_CONFIG` in `finally`.
Plus `test('default path resolution unchanged without KPP_CONFIG')` to pin the existing behavior.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/ryan/Code/kiro-pool-proxy && npx vitest run src/lib/config` (or the repo's runner — check its package.json)
Expected: FAIL — env var ignored.

- [ ] **Step 3: Implement**

Two-line change in `loadConfig`: `const configPath = process.env.KPP_CONFIG ? resolve(process.env.KPP_CONFIG) : resolve(__dirname, '../../config.json')`.

- [ ] **Step 4: Make the no-accounts error actionable (spec: cards fail fast with a fix)**

Find the account-selection error path (empty pool) and make its message state the fix: `No accounts in pool "<pool>" — run login first` (adjust to the existing message's voice). Add a test: `test('selecting from an empty pool reports a login-actionable error')` asserting the message contains both the pool name and `login`.

- [ ] **Step 5: Run tests to verify they pass**

Run: same as Step 2, plus the repo's full test suite.
Expected: PASS.

- [ ] **Step 6: Commit (in the kiro-pool-proxy repo)**

```bash
cd /home/ryan/Code/kiro-pool-proxy
git add -A src/
git commit -m "feat: KPP_CONFIG env override + actionable empty-pool error"
```

---

### Task 4: Bundle build + server.js client-dir override

The esbuild step that turns the existing TS sources into the three runnable bundles, plus the one backend change that lets the bundles point the SPA at a bundled asset dir.

**Files:**
- Create: `desktop/build-bundles.mjs`
- Modify: `server.js` — `const CLIENT_DIR = process.env.CLIENT_DIR ?? 'build/client'`; replace the four `'build/client'` literals with `CLIENT_DIR`
- Modify: `desktop/package.json` — `bundles` script runs `node build-bundles.mjs`
- Test: `desktop/build-bundles.test.mjs` (vitest)

**Interfaces:**
- Produces (consumed by Tasks 5, 6, 8): output layout inside `desktop/out/`:
  - `out/server.bundle.mjs` — entry `../server.js`, `bundle: true`, `platform: node`, `format: esm`, `target: node22` (floor: whatever Node version Task 8 ships — keep node22), externals: none except `better-sqlite3` (keep external — the prebuilt native `.node` file lives beside the bundle, resolved from `out/node_modules/better-sqlite3/`).
  - `out/orcd.bundle.mjs` — entry `../src/orcd/index.ts`, same options.
  - `out/kpp.bundle.mjs` — entry `<KPP_REPO>/src/cli.ts`, same options; `<KPP_REPO>` read from env `KPP_REPO` with fallback `/home/ryan/Code/kiro-pool-proxy` — the pinned local dependency (spec: repos stay independent, one source of truth).
  - `out/node/` — the bundled Node runtime, downloaded by the script from `nodejs.org/dist/` (tarball extracted for `process.platform`/`arch`), only if missing or `--force`.
  - `out/node_modules/better-sqlite3/` — prebuilt binary for plain Node via `npx prebuild-install -r node` run inside a temp dir with the root `better-sqlite3` version (the script `npm i`s better-sqlite3 into a temp prefix, then copies the `build/Release/*.node` + package metadata into `out/node_modules/better-sqlite3/`).
- SPA assets: the script copies `../build/client` → `out/client` (requires `bun run build` first — the script fails with a readable error if `../build/client/index.html` is missing).

- [ ] **Step 1: Write the failing build tests**

`desktop/build-bundles.test.mjs`:
- `test('build-bundles produces all five outputs')` — set a temp `OUT_DIR` (the script must honor `OUT_DIR` env, default `desktop/out`), run the script via `child_process.execFileSync(process.execPath, [script])` after a real `bun run tsoa:generate` + `bun run build` (skip the network parts: honor `SKIP_NODE_DOWNLOAD=1` and `SKIP_SQLITE_PREBUILD=1` env for tests), assert `out/server.bundle.mjs`, `out/orcd.bundle.mjs`, `out/kpp.bundle.mjs`, `out/client/index.html` exist and the `.mjs` files are non-empty.
- `test('server bundle rejects unknown client dir with default fallback')` is out of scope for the build script — the CLIENT_DIR behavior is instead pinned by a root-level smoke: add `test('server.bundle.mjs boots with CLIENT_DIR pointing at out/client')` — spawn `node out/server.bundle.mjs` with `env { CLIENT_DIR: <out>/client, PORT: <free>, HOST: '127.0.0.1', ORC_NODES: <temp orc.yaml>, ORC_CONFIG: <or not needed by backend — set to a temp dummy orchestratorless config only if the backend reads it: it does not; orcd does> }`, `cwd: <temp dir>` (so `data/orchestrel.db` lands in temp), wait for a 200 on `GET /`, assert body contains `<!DOCTYPE html` (or `<div id=` — whatever index.html contains), kill the child. Mark with a generous 30 s timeout. This is the integration proof the bundle is real.

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop && npx vitest run build-bundles.test.mjs`
Expected: FAIL — script missing.

- [ ] **Step 3: Implement `desktop/build-bundles.mjs` and the `server.js` change**

Script shape (single file, imperative, `set -ex`-equivalent early exits):
1. Check `<root>/build/client/index.html` exists → error "run `bun run build` first".
2. `execSync('bun run tsoa:generate', { cwd: root })` (bundles need the generated routes to exist at bundle time).
3. Three esbuild.build calls (API import from the desktop devDependency), externals `{ 'better-sqlite3': true }`, all three entries; fail the script on any esbuild error with the per-entry name.
4. Node download: if `out/node/node` missing (or `--force`): fetch `https://nodejs.org/dist/v22.x.y/node-v22.x.y-<platform>-<arch>.tar.xz` (pin the exact version constant at the top: pick the current LTS v22.x.y at implement time), `tar -xJ` into `out/node/`. Honor `SKIP_NODE_DOWNLOAD=1`.
5. SQLite prebuild: temp prefix, `npm i better-sqlite3@<root version> --no-save`, `npx prebuild-install -r node --runtime=node`, copy into `out/node_modules/better-sqlite3/`. Honor `SKIP_SQLITE_PREBUILD=1`.
6. `cp -r ../build/client out/client`.
Version constants (Node version, better-sqlite3 version read from root package.json) live at the top of the script.

`server.js` change is the one constant + four literal replacements (production branch only; dev branch untouched).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && npx vitest run build-bundles.test.mjs`
Expected: PASS (real bundle + boot smoke).

- [ ] **Step 5: Verify hosted path unaffected**

Run: `cd .. && npm run start` briefly with no `CLIENT_DIR` — server serves from `build/client` as before (curl the local port for the SPA). Kill it.

- [ ] **Step 6: Commit**

```bash
git add desktop/build-bundles.mjs desktop/build-bundles.test.mjs desktop/package.json server.js
git commit -m "feat(desktop): bundle build (server/orcd/kpp + node + sqlite) + CLIENT_DIR override"
```

---

### Task 5: `orchestrel` CLI shim

Install a stable-path CLI so `orchestrel kiro login` works with the app closed, on every platform that has `~/.local/bin` convention (Linux + macOS; Windows: shim goes to `%LOCALAPPDATA%\orchestrel\orchestrel.cmd` and the README documents prepending it to PATH).

**Files:**
- Create: `desktop/lib/shim.ts`, `desktop/lib/shim.test.ts`
- Test: `desktop/lib/shim.test.ts`

**Interfaces:**
- Produces (consumed by Task 6 main):
  - `buildCliHome(userDataDir: string, nodeBin: string, kppBundle: string): { cliHome: string; binPath: string; scriptContent: string }`
    - `cliHome = <userDataDir>/../local/orchestrel` is NOT used — fixed stable path per platform: `~/.local/share/orchestrel` (win: `%LOCALAPPDATA%\orchestrel`).
    - `binPath`: `~/.local/bin/orchestrel` / win cmd path.
    - `scriptContent`: a POSIX sh script (win: batch) that copies nothing at runtime — it `exec`s (sh: `exec`; win: `call`) `<cliHome>\node <cliHome>\kpp.bundle.mjs` with `KPP_CONFIG=<userData>/kiro/config.json` and the args forwarded.
  - `installShim(home: ReturnType<typeof buildCliHome>, { nodeBin, kppBundle, binPath }): Promise<{ changed: boolean }>` — idempotent: ensures `cliHome/node` (hardlink or copy of the bundled node) and `cliHome/kpp.bundle.mjs` (copy) exist and match the current install (compare `mtime`/size, skip copy when identical — repair semantics), writes `binPath` script atomically (write temp + rename), `chmod 755`. Returns `changed` so main can log "CLI updated".
- Consumes: none (pure fs + `node:os`).

- [ ] **Step 1: Write the failing tests**

- `test('scriptContent quotes paths with spaces')` — `buildCliHome` inputs with `userDataDir = '/tmp/a b/Orchestrel'`; assert the script lines contain the paths inside double quotes and contain `KPP_CONFIG=`.
- `test('installShim is idempotent')` — fake nodeBin/kppBundle as mkdtemp files with known content; call `installShim` twice (HOME overridden to a temp dir via `os.homedir` mock or a `homeDir` parameter — production differs by platform so a platform/home parameter is a real seam: `installShim(home, { …, homeDir })`); second call returns `changed: false`; `binPath` executable bit set.
- `test('installShim repairs a stale bundle after app move')` — after first install, change the kppBundle content and re-run; assert the copied bundle matches new content and `changed: true`.
- `test('shim actually runs the bundled KPP CLI')` — integration: temp HOME, temp fake nodeBin = real `process.execPath`, temp kppBundle = a 5-line stub script that prints `args.join(',')`; execute `binPath` via `child_process.execFile(scriptPath, ['status'])`; assert stdout contains the stub output. (Skips on Windows dev boxes if the runner is POSIX-only: the batch path is pinned by content assertion instead.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop && npx vitest run lib/shim.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `desktop/lib/shim.ts`**

Straightforward from the interfaces. sh script shape (POSIX):
```sh
#!/bin/sh
exec "<cliHome>/node" "<cliHome>/kpp.bundle.mjs" "$@"
```
with `KPP_CONFIG` exported on the line before. Batch equivalent for Windows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && npx vitest run lib/shim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/lib/shim.ts desktop/lib/shim.test.ts
git commit -m "feat(desktop): orchestrel CLI shim install (kiro auth)"
```

---

### Task 6: Electron main — window, menu, logs, crash window, dev run

Assemble `desktop/main/` on top of the pure libs. This task's deliverable is the runnable app end-to-end on the build machine (manual verification — Electron window behavior is not unit-tested).

**Files:**
- Create: `desktop/main/main.ts` — entry (compiled by esbuild to `dist/main.cjs`, add a `predev`/`prestart` script or extend Task 4's build to compile it)
- Create: `desktop/main/window.ts` (BrowserWindow factory: 1280×900, min 900×650, `webPreferences: { preload, contextIsolation: true, nodeIntegration: false }`), `desktop/main/preload.ts` (exposes only: `onUpdateReady(cb)`, `openExternal(url)`, `openLogsFolder()` — `contextBridge` whitelist), `desktop/main/crash-window.ts` (modal-ish 520×360 BrowserWindow loading an inline `data:` HTML with: service id, log tail in a scrollable pre, buttons Restart services / Quit / Copy logs)
- Modify: `desktop/package.json` — `main: dist/main.cjs`, `start` = build main + spawn electron with `ORCHESTREL_APP_OUT=<out dir>`
- Create: `desktop/main/main.test.ts` for the pure slice: `serviceDefsFromBootstrap(bootstrap, outDir, nodeBin): ServiceDef[]`

**Interfaces:**
- Consumes: `Supervisor`/`ServiceDef`/`SupervisorOptions` (T1), `seedUserData` (T2), `buildCliHome`/`installShim` (T5), `bootstrap` (T1).
- Produces: `serviceDefsFromBootstrap(b: BootstrapData, outDir: string, nodeBin: string): ServiceDef[]` with the exact spawn recipe:
  - kpp: `[<nodeBin>, <out>/kpp.bundle.mjs, serve]`, `env.KPP_CONFIG = <userData>/kiro/config.json`, `cwd: <out>`
  - orcd: `[<nodeBin>, <out>/orcd.bundle.mjs]`, `env.ORC_CONFIG = <userData>/orcd.yaml`, `cwd: <userData>` (orcd's relative dirs — preferences/staging — stay under userData)
  - backend: `[<nodeBin>, <out>/server.bundle.mjs]`, `env { PORT: String(b.backendPort), HOST: '127.0.0.1', CLIENT_DIR: <out>/client, ORC_NODES: <userData>/orc.yaml }`, `cwd: <userData>` (so `data/orchestrel.db` → `userData/data/orchestrel.db`)
  - all: `env.PATH` inherited; nothing sensitive leaked.
- Boot sequence in `main.ts` (imperative, top to bottom): `app.requestSingleInstanceLock()` (second instance → `focus` existing window, quit) → `seedUserData(userData)` → `installShim(…)` (log `changed`) → `new Supervisor({ logDir: <userData>/logs, nodeBin: <out>/node/<binname>, healthUrl: http://127.0.0.1:<backendPort>/ , spawn: childProcess.spawn })` → `supervisor.start(serviceDefsFromBootstrap(…))` → create main window at the healthUrl → wire `supervisor.on('crash')` → crash window (button actions: restart = re-`start()` the crashed def's reset internal counter by constructing the replacement via a supervisor `restart(id)` — add `restart(id: string): Promise<void>` to `Supervisor` in this task, with a test: `test('restart(id) resets the rate window and respawns once')`); `app.on('before-quit')` → `await supervisor.stop()`; menu items: Open logs folder (`shell.openPath(logDir)`), Check for updates now (added by Task 7), About.
- Window hardening carried over from the old wrapper: `internalHosts` set for `will-navigate`/`setWindowOpenHandler` (allow only `127.0.0.1:<backendPort>`; everything else → `shell.openExternal`), disable the renderer-guard env flags (iPad-era macOS tuning is irrelevant for a single-tab local app).

- [ ] **Step 1: Write the failing test**

`desktop/main/main.test.ts`:
- `test('serviceDefsFromBootstrap maps all three services with the exact env, cwd, args')` — dev outDir is `<desktop pkg>/out` (Task 8 swaps it for asar-aware `resolveOutDir`; keep the call to a single `outDirFor(): string` helper so T8 changes one line)
- `test('desktop/main and desktop/lib never import a native module')` — read every `.ts` under `desktop/main/` and `desktop/lib/`, assert no `import`/`require` of `better-sqlite3` or any other `.node` consumer (pins the ABI-leak review focus) — snapshot-free explicit assertions on each def (ids, command = nodeBin, args arrays, env keys/values, cwd) using a fixture bootstrap and paths containing a space (pins the Review-Focus quoting line at the spawn-recipe level).
- `test('Supervisor.restart(id) respawns after giving up')` — add to `desktop/lib/supervisor.test.ts`: trigger give-up (6 fast exits), `await restart(id)`, kill once more → it respawns again (window reset).

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop && npx vitest run main lib`
Expected: FAIL.

- [ ] **Step 3: Implement `main.ts`, `window.ts`, `preload.ts`, `crash-window.ts`, and `Supervisor.restart`**

Per the interfaces. Keep `main.ts` a thin imperative sequence — no abstractions for one-shot boot.

- [ ] **Step 4: Typecheck + all desktop tests**

Run: `cd desktop && npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Manual end-to-end (build machine)**

```bash
cd desktop && npm run bundles && npm start
```
Checklist: window opens on the board; a Kiro-provider card posts an actionable "no Kiro accounts — run `orchestrel kiro login`" error when used with zero accounts; `~/.local/bin/orchestrel status` works with the app CLOSED; kill the backend child (`kill <pid>`) → it respawns transparently; kill it 6× fast → crash window appears with log tail, Restart works; quit app → `pgrep -f server.bundle` shows nothing; relaunch → second-instance lock: a second `npm start` focuses the first window and exits; `userData/data/orchestrel.db` exists; `userData/logs/` has three growing files; `orchestrel kiro status` from a fresh shell shows the (empty) pools.

- [ ] **Step 6: Commit**

```bash
git add desktop/main desktop/package.json desktop/lib/supervisor.ts desktop/lib/supervisor.test.ts
git commit -m "feat(desktop): electron main — boot, window, crash window, single instance"
```

---

### Task 7: Auto-update from GitHub Releases

**Files:**
- Create: `desktop/main/updater.ts`, `desktop/main/updater.test.ts`
- Modify: `desktop/main/main.ts` (wire `initUpdater(win, onCrashHooks)` on boot + menu item), `desktop/main/preload.ts` (expose `onUpdateReady`)
- Create: `desktop/RELEASES.md` snippet merged into `desktop/README.md` (feed = releases on the public orchestrel repo; how the app finds them)

**Interfaces:**
- Consumes: `electron-updater` `autoUpdater` (github provider, owner/repo from build-time env `UPDATER_OWNER`/`UPDATER_REPO` injected via `desktop/electron-builder-common.yml`'s `publish` config — values `rbrcurtis`/`orchestrel`, verify the actual GitHub owner at implement time).
- Produces:
  - `initUpdater(showDialog: (info: UpdateInfo) => void): void` — `autoUpdater.autoDownload = true`, `autoInstallOnAppQuit = true`; on `update-downloaded` → call `showDialog({ version })` with a "Restart now" button that `app.relaunch() + app.quit()`.
  - Check cadence: at boot + every 4 h. `checkForUpdates('manual')` exposed to the menu.
- The pure, testable slice: `shouldCheck(lastCheckAtMs: number | null, now: number, INTERVAL_MS): boolean` and `updateFeedPath(version: string, platform: string): string` (the `latest.yml` / `latest-linux.yml` / `latest-mac.yml` naming electron-updater expects) — these live in `updater.ts` and get unit tests; the electron-updater wiring itself is pinned by the manual step.

- [ ] **Step 1: Write the failing tests**

- `test('shouldCheck is true when never checked, after the interval, and false inside it')`
- `test('updateFeedPath names the per-platform yml correctly')` — linux→`latest-linux.yml`, darwin→`latest-mac.yml`, win32→`latest.yml`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd desktop && npx vitest run main/updater.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `updater.ts`, wire main + preload + menu**

- [ ] **Step 4: Typecheck + tests**

Run: `cd desktop && npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Manual**

Local feed test: stand up a static dir with a hand-made `latest-linux.yml` pointing at the current build's `AppImage` (bump the version string by 1), run the app with `autoUpdater.setFeedURL('http://127.0.0.1:<port>')` forced behind a temporary `UPDATER_FEED_OVERRIDE` env (kept permanently — it's a real ops seam, not a test-only one); expect the "Orchestrel X.Y.Z is available" dialog. Then verify the menu item "Check for updates now" hits the real GitHub feed (network): with no newer release it silently no-ops with a console line.

- [ ] **Step 6: Commit**

```bash
git add desktop/main desktop/README.md
git commit -m "feat(desktop): electron-updater wired to GitHub releases"
```

---

### Task 8: Packaging, release script, smoke checklists

**Files:**
- Create: `desktop/electron-builder-linux.yml`, `desktop/electron-builder-mac.yml`, `desktop/electron-builder-win.yml`
- Create: `scripts/package-desktop.sh` (repo root, `set -ex`)
- Create: `desktop/README.md` — dev loop, per-platform smoke checklists, Kiro CLI usage, update-feed operations
- Modify: `desktop/package.json` scripts (`build:linux` etc. per target)

**Interfaces:**
- Consumes: `desktop/out/` layout from Task 4 (bundles, `out/node`, `out/node_modules/better-sqlite3`, `out/client`), version from `desktop/package.json`.
- Produces: GitHub Release artifacts — per target: linux `Orchestrel-x.y.z.AppImage` + `.deb`, mac `Orchestrel-x.y.z.dmg` + `.zip`, win `Orchestrel Setup x.y.z.exe`, plus `latest*.yml` (electron-builder emits these automatically with `publish: github`).
- Builder configs: `appId: com.rbrcurtis.orchestrel`; `files: ["dist/**", "out/**"]` with `asarUnpack: ["out/node/**", "out/node_modules/**/*.node"]` (native + runtime must be unpacked); mac: `arm64` only, `identity: null` (ad-hoc) — with a comment citing the ad-hoc caveat; linux: `AppImage` + `deb`; win: `nsis`; `extraResources` not needed (out/ is in `files` and referenced via `process.resourcesPath`/`app.getAppPath()` — main resolves `outDir` from `app.getAppPath() + '/out'` in asar-unpacked form; pin the exact resolution in main.ts: `<resourcesPath>/app.asar/out` is WRONG for unpacked paths — use `process.resourcesPath/app.asar.unpacked/out`; add a small `resolveOutDir(): string` in main with a unit test for both dev (no asar → `<pkg>/out`) and packaged (mock `process.resourcesPath`) forms).
- `scripts/package-desktop.sh` (single purpose, `set -ex`): args `--target linux|mac|win --version <semver> [--release]`. Body: bump `desktop/package.json` version to `$VERSION` (node one-liner) → `bun run build` → `node desktop/build-bundles.mjs` (downloads node runtime + sqlite prebuild for the TARGET platform — add a `--platform` flag to the build script in this task so mac builds on `oni` fetch darwin/arm64 node) → `npx electron-builder --config desktop/electron-builder-$TARGET.yml` → if `--release`: `gh release create vX.Y.Z <artifact globs>` (GH_TOKEN from env; draft by default, `--draft` off only when `--publish` is also passed).

- [ ] **Step 1: Write the failing `resolveOutDir` test**

`desktop/main/main.test.ts`: `test('resolveOutDir uses asar.unpacked path when packaged and plain out/ in dev')` — dev form with real `__dirname`; packaged form by mocking `process.resourcesPath` + setting `process.env.ELECTRON_IS_ASAR='1'`, assert the returned path contains `app.asar.unpacked/out`.

- [ ] **Step 2: Implement `resolveOutDir`, the three builder YAMLs, and `scripts/package-desktop.sh`**

- [ ] **Step 3: Local package dry-run (build machine, Linux)**

```bash
scripts/package-desktop.sh --target linux --version 0.1.0
```
Expected: `desktop/dist/linux*/Orchestrel-0.1.0.AppImage` + `.deb` exist (no `--release`). No `gh` call.

- [ ] **Step 4: Packaged smoke checklist — run the ACTUAL AppImage** (this is the task's real gate; do not ship a build you only ran unpacked):

- [ ] AppImage launches, window shows the board
- [ ] `~/.local/bin/orchestrel status` works (shim repaired on launch)
- [ ] `orchestrel kiro login local` prints device-code URL + code; abort with Ctrl-C leaves no half-written account (`orchestrel kiro status` unchanged)
- [ ] complete a real Kiro login; a Kiro-provider card runs a real session end to end (board shows stream, card moves to review on session exit)
- [ ] quit, relaunch, DB and Kiro accounts persist
- [ ] kill -9 the AppImage; no orphan `node` children survive
- [ ] `.deb` install on the same box: second userData? (no — same path, same data, just verifies the deb variant boots)

- [ ] **Step 5: Write `desktop/README.md`**

Dev loop (bundles + start), Kiro CLI (login/status/logout/refresh, expiry behavior — AWS's error surfaces verbatim, no retry), macOS build on `oni` (`zsh -lic` node path, `CSC_IDENTITY_AUTO_DISCOVERY=false` per the existing build notes, ad-hoc caveats: permission resets per version, right-click→Open), Windows build + SmartScreen note, release procedure (`scripts/package-desktop.sh --target <t> --version X --release --publish`), per-platform smoke checklist (same as Step 4, condensed), update-feed notes (GitHub releases on the public repo).

- [ ] **Step 6: Commit**

```bash
git add desktop scripts/package-desktop.sh
git commit -m "feat(desktop): electron-builder targets, release script, packaged smoke checklist"
```

---

## Verification summary

- Unit/integration: `cd desktop && npx vitest run` (supervisor, bootstrap, seed, shim, build+boot smoke, main mappings, updater logic, resolveOutDir); root suite `npx vitest run` still green (backend user-seed test).
- kiro-pool-proxy suite green after Task 3.
- Hosted deployment regression: root `npm run start` with no env overrides behaves identically (Task 4 Step 5) — the only root-repo code delta is the `CLIENT_DIR` default-preserving override and the idempotent empty-users seed.
- Manual gates: Task 6 Step 5 (dev run), Task 8 Step 4 (packaged AppImage).
