# Multi-orcd: Remote Execution Nodes

**Date:** 2026-06-29
**Status:** Design — approved, pending implementation plan

## Problem

Work increasingly needs to run on remote machines (a project's repo lives on a
specific box, or a box has tooling/secrets we can't relocate). Today the only
way to drive that is a babysat persistent SSH session, which is fragile and —
worse — degrades agents: their native edit tools don't work over SSH, so edits
fall back to `sed`-style operations on a remote filesystem, which is slow and
error-prone.

The fix is to run the agent **on the box that holds the files**, so native edit
tools operate on a local filesystem, while orchestration and the UI stay
central.

## Goals

- Run agent processes on remote machines where the project files physically live.
- Let the central Orc backend (BE) and frontend (FE) drive **multiple** orcd
  servers, each on its own machine.
- Keep all authoritative orchestration state (cards DB, routing) central.
- Survive flaky transport to a node without losing session work.

## Non-goals

- A new daemon tier / dispatcher. Earlier explored and rejected.
- Inference relay design. Where a node sends inference is purely its own
  `orcd.yaml` concern (any network-reachable endpoint), exactly as today.
- One project spanning multiple nodes. A project is bound to exactly one node.
- Auto-discovery of nodes (static registry only).
- mTLS (shared-token auth is sufficient for the trusted VPN/LAN assumption).
- JSONL event rehydration after a long outage (see "Resilience"). Out of scope
  for v1; a larger ring buffer covers expected outages.

## Decisions (locked)

| # | Decision |
|---|----------|
| 1 | Agent runs on the node (filesystem locality — native edit tools). |
| 2 | Latency is a non-concern (nodes are same-LAN or VPN-reachable). |
| 3 | One orcd per box, managing multiple projects (cwd is per-session). |
| 4 | A **project is bound to one node** — the box holding its repo folder. |
| 5 | A **card inherits its project's node and can never change it** (session history + files live there). |
| 6 | orcd owns **all node-local filesystem work** (worktree create/remove, git, `setup_commands`, path validation, opencode-config copy). PR/push already happens agent-side and needs no BE involvement. |
| 7 | Transport is **TCP only** (hard cutover; drop the unix socket entirely; local node is `127.0.0.1`). |
| 8 | Auth is a **shared token per node**. |
| 9 | Config splits by owner: `orcd.yaml` per box, `orc.yaml` on the BE. The BE stops reading provider config from any local file. |
| 10 | Request/reply protocol actions correlate via a generic `requestId` field. |
| 11 | Capabilities are cached in-memory per node. An offline node can't accept new projects/cards; existing cards on it render read-only from FE cache and are not runnable. |

## Architecture

No new tier. Same layers as today; changes concentrate in BE/FE plus additive
changes to orcd.

```
1 Orc UI (FE)        node-aware: pick node per project; capability-constrained
                     provider/model; per-node connection status
        │ websocket (existing)
2 Orc Backend (BE)   pure orchestrator: N orcd connections, capability
                     aggregation, per-card routing. No local git/fs work.
        │ orcd-protocol over TCP (one connection per node, shared-token auth)
3 orcd (per box)     unchanged session lifecycle + NEW: TCP listen, token auth,
                     capabilities reporting, node-local worktree/git/setup
        │ spawn
4 Agent processes    run on the node; native local edits; run `gh pr create`
        │ ANTHROPIC_BASE_URL (per node's orcd.yaml)
5 Inference target   wherever orcd.yaml points (relay/provider/Bedrock/etc.)
```

**Symmetry invariant:** the local orcd is just another entry in `orc.yaml`
(`127.0.0.1:<port>`). There is exactly one code path; "local" is the degenerate
node.

## Configuration

### `orcd.yaml` (per box — supersedes today's `config.yaml`)

> **Not a pure rename.** Today `config.yaml` is loaded by *both* orcd and the BE
> via `src/shared/config.ts`, and the BE serves the provider catalog to the FE
> from it. After this change, provider config is owned by orcd alone. The BE no
> longer reads provider data from any local file (see BE changes §1).

Same provider shape as today's `config.yaml` plus a `listen` address and an auth
token; the `socket` field is removed.

```yaml
# orcd.yaml — lives on the box, owned by this orcd
listen:
  host: 0.0.0.0        # bind address (prefer the VPN interface)
  port: 7420
authToken: ${ORCD_TOKEN}   # shared token the BE must present

defaultProvider: anthropic
defaultModel: sonnet
defaultCwd: ~/Code

providers:
  anthropic:
    label: Anthropic
    models:
      sonnet: { label: "Sonnet 4.6", modelID: claude-sonnet-4-6, contextWindow: 1000000 }
      # ...
```

Secrets and inference routing remain per-box in `orcd.yaml`, unchanged from how
orcd resolves provider env today (`buildProviderEnv` in `socket-server.ts`).

### `orc.yaml` (new — on the BE / home machine)

Owned by the BE. A static discovery registry of nodes — a brand-new, small
schema unrelated to the provider config. The BE reads only this file.

```yaml
# orc.yaml — node registry, owned by the BE
servers:
  - name: local
    host: 127.0.0.1
    port: 7420
    authToken: ${LOCAL_ORCD_TOKEN}
  - name: gpubox
    host: 10.8.0.3        # VPN address
    port: 7420
    authToken: ${GPUBOX_ORCD_TOKEN}
```

`name` is the stable identifier persisted on projects/cards. Editing `orc.yaml`
and restarting the BE adds/removes nodes. (Hot-reload is a future nice-to-have.)

## Protocol changes (`src/shared/orcd-protocol.ts`)

All additive and backward-compatible.

### Generic request/reply correlation

Add an optional `requestId?: string` field to actions. orcd echoes it on the
matching reply message. This is the single correlation mechanism for all new
request/reply actions. `OrcdClient` gains a pending-request map keyed by
`requestId`, with per-request timeout and error propagation back to the caller
(so a failed `worktree_prepare` surfaces a real error on the card rather than a
silently dropped action).

The existing `create` (ordered `pendingCreates` queue) and `list` (message-type
match) correlation keep working as-is. Migrate them onto `requestId` only if
low-risk during implementation — no churn of proven code for its own sake.

### New client→orcd actions

- **`hello`** — first message after connect. Carries `{ token, requestId }`. orcd
  validates against its `authToken`; on mismatch it replies with an error and
  closes. On success it replies with `capabilities` (below). Connections that
  haven't said a valid `hello` may issue no other actions.
- **`capabilities`** — also implicitly returned by `hello`. orcd replies:
  ```ts
  {
    type: 'capabilities';
    requestId?: string;
    name: string;                 // node name as orcd knows itself (informational)
    providers: Array<{
      id: string;
      label: string;
      models: Array<{ alias: string; label: string; contextWindow: number }>;
    }>;
    defaults: { provider: string; model: string };
  }
  ```
- **`worktree_prepare`** — `{ requestId, projectPath, branch, sourceBranch, setupCommands }`
  → reply `worktree_ready { requestId, path, branch }` or `error { requestId, error }`.
  orcd creates the worktree, runs `setup_commands`, copies `opencode.json`, and
  returns the resolved `cwd`. All on the node.
- **`worktree_remove`** — `{ requestId, projectPath, path }` → `ok { requestId }`
  or `error`. Cleanup on the node.
- **`path_validate`** — `{ requestId, path }` → `{ requestId, exists, isGitRepo, defaultBranch }`
  for project-form validation against the node's filesystem.

The existing `create` action keeps taking a prepared `cwd`: the BE calls
`worktree_prepare`, receives `path`, then issues `create { cwd: path, ... }`.
This preserves the clean "prepare, then run" split.

## orcd changes

orcd's session lifecycle, ring buffer, JSONL persistence, compaction, and
provider-env resolution are **unchanged**. Additions only:

1. **TCP listener.** `socket-server.ts` switches `server.listen(socketPath)` to
   `server.listen({ host, port })` from `orcd.yaml.listen`. `net.createServer`
   already returns a stream server, so framing (newline-delimited JSON) is
   unchanged. **Remove all unix-socket code** (`socketPath`, stale-file unlink,
   `mkdir` of the socket dir) — hard cutover, no dual transport.
2. **Token auth.** Gate the connection on a valid `hello.token`; reject and
   close otherwise. Track a per-connection "authenticated" flag; drop any action
   that arrives before a valid `hello`.
3. **Capabilities reporting.** Derive the `capabilities` payload from the
   already-loaded `orcd.yaml` providers/models.
4. **Node-local filesystem ownership.** Implement the worktree/path actions by
   moving the logic currently in the BE's `src/server/worktree.ts`
   (`createWorktree`, `removeWorktree`, `runSetupCommands`, `worktreeExists`,
   `copyOpencodeConfig`, source-branch resolution) onto orcd, reusing
   `src/shared/worktree.ts` (`resolveWorkDir`, `slugify`). The `runSetupCommands`
   PATH-fixup currently hardcodes `/home/ryan/.local/bin` and `process.execPath`'s
   bin dir — these now resolve against the **node's** environment, not the BE's.

## BE changes

The BE stops doing any git/filesystem work and becomes a pure orchestrator.

1. **Provider config path removed.** `src/server/config/providers.ts`
   (`loadProviders`, `getProvidersForClient`, `getModelConfig`,
   `getDefaultModel`, `getDefaultProviderID`) is **deleted**. Provider/model data
   no longer comes from a local file. It is replaced by the in-memory per-node
   capability cache (§3). `src/shared/config.ts` remains, used only by orcd.
2. **Multi-client registry.** Replace the single `OrcdClient` in
   `src/server/init-state.ts` with a **map keyed by node name**. Each entry is an
   `OrcdClient` with its own TCP connection, shared-token `hello`, reconnect
   state, and event-replay cursor. The map lives in the dynamically-imported
   `init-state` module so it survives Vite dev-server restarts.
3. **TCP transport + capability cache in `OrcdClient`.** `OrcdClient` currently
   dials a unix path (`~/.orc/orcd.sock`). It gains `{ host, port, token }`,
   performs the `hello` handshake on connect, and caches the node's
   `capabilities`. On each connect/reconnect it re-runs `hello` and refreshes the
   cache. Capabilities are in-memory only — not persisted.
4. **Capability aggregation.** Expose the aggregated catalog to the FE via the
   existing `sync` event (replacing `getProvidersForClient()` in
   `src/server/ws/handlers/projects.ts`): which nodes exist, their connection
   state, and per-node providers/models. An offline node contributes its name +
   offline state but no selectable capabilities.
5. **Routing.** Every card carries `node_name`. The BE routes that card's
   `create`/`message`/`cancel`/worktree actions to that node's client, and
   validates the card's provider/model against that node's advertised
   capabilities.
6. **Remove local git/fs.** Two touchpoints switch from local execution to
   protocol calls against the card's node:
   - **Creation:** `src/server/sessions/worktree.ts` (`createWorktree` +
     `runSetupCommands` + `copyOpencodeConfig`) → one `worktree_prepare`.
   - **Cleanup:** `src/server/controllers/card-sessions.ts` (~L365, the
     `board:changed` cleanup handler — `worktreeExists` + `removeWorktree`) →
     `worktree_remove`. Best-effort: if the node is offline, log and move on
     (orphaned worktrees are a tolerable edge; a reconcile-on-reconnect sweep is
     future work).
   - Other callers to update: `src/server/services/card.ts`,
     `src/server/ws/handlers/sessions.ts` (which use `resolveWorkDir`).
   - `resolveWorkDir` stays in `src/shared/worktree.ts` but now describes a path
     **on the node**. The BE must not `existsSync`/touch that path — it flows
     through the protocol (`worktree_prepare` returns `path`; `worktree_remove`
     takes it).
   - Project path validation in `src/server/services/project.ts`
     (`existsSync(join(path, '.git'))`) → `path_validate` against the project's
     node.

## FE changes

1. **Project form** picks a **node** first (from the connected-node list), then
   provider/model constrained to that node's capabilities. `project.path` is
   validated via `path_validate` against the chosen node. Offline nodes are not
   selectable for new projects.
2. **Card create** inherits the project's node/provider/model; node is shown but
   not editable.
3. **Per-node connection status** indicator.
4. **Offline-node card state.** A card whose node is offline:
   - shows a "node offline / reconnecting" state;
   - paints its transcript **read-only** from the FE conversation cache if
     present (cards are cached client-side);
   - disables all action affordances (send message, cancel, effort change) — the
     agent lives on the node and cannot run while the node is unreachable;
   - is never torn down due to the transport drop — only orcd's authoritative
     `session_exit` moves a card to review.

## Data model changes

- `projects`:
  - add `node_name TEXT NOT NULL DEFAULT 'local'` — the node holding the repo.
    (`provider_id`, `default_model`, `default_thinking_level` already exist and
    become constrained to the node's capabilities.)
- `cards`:
  - add `node_name TEXT NOT NULL DEFAULT 'local'` — **snapshot** from the project
    at creation; immutable thereafter. Decouples the card's session location from
    later project edits/deletes (`project_id` is `ON DELETE SET NULL`).

Backfill both to `'local'` so existing data maps onto the single local node.
Schema additions via `ALTER TABLE ADD COLUMN` per the project's DB guardrails.

## Data flow

**Project creation:** FE picks node → BE `path_validate` on that node → persist
project with `node_name` + node-constrained provider/model.

**Card → session:** card created with project's `node_name` snapshot → BE looks
up that node's `OrcdClient` → `worktree_prepare` (orcd builds worktree + runs
setup + copies opencode config on the box) → `worktree_ready { path }` → BE
`create { cwd: path }` → orcd spawns the agent on the box → events stream back
over the node's connection and forward to the UI as today.

**Inference:** the agent uses the env orcd built from *its* `orcd.yaml`
(`ANTHROPIC_BASE_URL` etc.) — central relay or direct, the BE is uninvolved.

**PR/push:** the agent runs `gh pr create` / `git push` inside its own session
on the node. `pr_url` is just a stored column on the card; no BE git work.

## Resilience (unreliable transport on a node)

A node may have flaky connectivity. Because **orcd owns session lifecycle**, the
agent keeps working on the box while the BE↔node link is down. Mechanisms:

- **Independent per-node reconnect** with backoff (reuses `OrcdClient` reconnect).
  One flaky node never affects others.
- **Lossless catch-up:** on reconnect the BE re-subscribes with
  `subscribe { afterEventIndex }` and orcd replays buffered events from the
  in-memory ring buffer.
- **Outage tolerance via ring-buffer sizing:** size the per-session ring buffer
  (currently 1000 events) to cover the max expected outage. An outage that
  exceeds the buffer is an accepted, uncovered edge in v1 — **no** JSONL
  rehydration. (Set the buffer size explicitly as a tuning parameter.)
- **UI:** card shows node connection state (read-only from cache when offline);
  session is never torn down due to a transport drop.

## Security

- Shared token per node: orcd reads `authToken` from `orcd.yaml`; the BE sends
  the matching token (from `orc.yaml`) in `hello`. Fails closed if the TCP port
  is ever exposed. Tokens are per-node and revocable.
- Prefer binding `listen.host` to the VPN interface and firewalling the port.

## Migration

1. Replace `config.yaml` with `orcd.yaml`: drop `socket:`, add `listen:` +
   `authToken:`. Update `config.example.yaml` → `orcd.example.yaml`.
2. Add `orc.yaml` with a single `local` entry pointing at `127.0.0.1:7420` +
   token.
3. `ALTER TABLE projects ADD COLUMN node_name TEXT NOT NULL DEFAULT 'local'`.
4. `ALTER TABLE cards ADD COLUMN node_name TEXT NOT NULL DEFAULT 'local'`.
5. Ship orcd's TCP listener + auth (unix socket removed); existing local setup
   keeps working via the `local` node at `127.0.0.1:7420`.

## Testing strategy

- **orcd:** token auth (accept/reject/close, action-before-hello dropped);
  `capabilities` payload from a sample `orcd.yaml`;
  `worktree_prepare`/`worktree_remove`/`path_validate` against a temp git repo;
  TCP framing parity with previous unix-socket behavior.
- **BE:** multi-client registry lifecycle across simulated Vite restarts;
  routing a card to the correct node; capability validation rejects a
  provider/model not advertised by the node; reconnect + `afterEventIndex`
  replay; `requestId` correlation (match, timeout, error propagation).
- **FE:** node-constrained provider/model picker; offline-node card renders
  read-only from cache with actions disabled; project-form `path_validate` flow.
- **Integration:** two orcd instances (two ports on `127.0.0.1` standing in for
  two boxes); create projects on each; verify isolation and independent
  reconnect.

## Open questions / future

- Hot-reload of `orc.yaml` (add/remove nodes without BE restart) — nice-to-have.
- Reconcile-on-reconnect sweep to clean up worktrees orphaned while a node was
  offline.
- Same repo on multiple nodes (would require relaxing the one-project-one-node
  binding) — explicitly out of scope now.
- JSONL event rehydration for outages exceeding the ring buffer — deferred.
- mTLS upgrade path if nodes ever leave the trusted network.
