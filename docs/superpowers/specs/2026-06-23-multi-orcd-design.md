# Multi-orcd: Remote Execution Nodes

**Date:** 2026-06-23
**Status:** Design — pending review

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

## Decisions (locked during brainstorming)

| # | Decision |
|---|----------|
| 1 | Agent runs on the node (filesystem locality — native edit tools). |
| 2 | Latency is a non-concern (nodes are same-LAN or VPN-reachable). |
| 3 | One orcd per box, managing multiple projects (cwd is per-session). |
| 4 | A **project is bound to one node** — the box holding its repo folder. |
| 5 | A **card inherits its project's node and can never change it** (session history + files live there). |
| 6 | orcd owns **all node-local filesystem work** (worktree, git, `setup_commands`, path validation, PR/push). |
| 7 | Transport is **TCP only** (drop the unix socket; local node is `127.0.0.1`). |
| 8 | Auth is a **shared token per node**. |
| 9 | Config splits by owner: `orcd.yaml` per box, `orc.yaml` on the BE. |

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
4 Agent processes    run on the node; native local edits
        │ ANTHROPIC_BASE_URL (per node's orcd.yaml)
5 Inference target   wherever orcd.yaml points (relay/provider/Bedrock/etc.)
```

**Symmetry invariant:** the local orcd is just another entry in `orc.yaml`
(`127.0.0.1:<port>`). There is exactly one code path; "local" is the degenerate
node.

## Configuration

### `orcd.yaml` (per box — rename of today's `config.yaml`)

Owned by each orcd. Same shape as today's `config.yaml` plus a listen address
and an auth token; the `socket` field is replaced by `listen`.

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
orcd resolves provider env today (`buildProviderEnv`).

### `orc.yaml` (new — on the BE / home machine)

Owned by the BE. A static discovery registry of nodes.

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
and reloading adds/removes nodes.

## Protocol changes (`src/shared/orcd-protocol.ts`)

All additive and backward-compatible. New client→orcd actions:

- **`hello`** — first message after connect. Carries `{ token }`. orcd validates
  against its `authToken`; on mismatch it replies with an error and closes. On
  success it replies with `capabilities` (below). Connections that haven't said
  a valid `hello` may issue no other actions.
- **`capabilities`** (also implicitly returned by `hello`) — orcd replies:
  ```ts
  {
    type: 'capabilities';
    name: string;                 // node name as orcd knows itself (informational)
    providers: Array<{
      id: string;
      label: string;
      models: Array<{ alias: string; label: string; contextWindow: number }>;
    }>;
    defaults: { provider: string; model: string };
  }
  ```
- **Worktree / node-local filesystem actions** (orcd executes on its box, reusing
  `src/shared/worktree.ts`):
  - `worktree_prepare` — `{ projectPath, branch, sourceBranch, setupCommands }`
    → reply `worktree_ready { path, branch }` or `error`. Creates the worktree
    and runs `setup_commands` on the node, returns the resolved `cwd`.
  - `worktree_remove` — `{ path }` → cleanup.
  - `path_validate` — `{ path }` → `{ exists, isGitRepo, defaultBranch }` for
    project-form validation against the node's filesystem.
  - (PR/push reuse existing git-on-node paths; folded under the same ownership.)

The existing `create` action keeps taking a prepared `cwd`: the BE calls
`worktree_prepare`, receives `path`, then issues `create { cwd: path, ... }`.
This preserves the clean "prepare, then run" split.

## orcd changes

orcd's session lifecycle, ring buffer, JSONL persistence, compaction, and
provider-env resolution are **unchanged**. Additions only:

1. **TCP listener.** `socket-server.ts` switches `server.listen(socketPath)` to
   `server.listen({ host, port })` from `orcd.yaml.listen`. `net.createServer`
   already returns a stream server, so framing (newline-delimited JSON) is
   unchanged.
2. **Token auth.** Gate the connection on a valid `hello.token`; reject and
   close otherwise.
3. **Capabilities reporting.** Derive the `capabilities` payload from the
   already-loaded `orcd.yaml` providers/models.
4. **Node-local filesystem ownership.** Implement the worktree/path actions by
   moving the logic currently in the BE's `src/server/worktree.ts` (which shells
   `git` via `child_process`) onto orcd, reusing `src/shared/worktree.ts`.

## BE changes

The BE stops doing any git/filesystem work and becomes a pure orchestrator.

1. **Multi-client registry.** Replace the single `OrcdClient` in
   `src/server/init-state.ts` with a **map keyed by node name**. Each entry is an
   `OrcdClient` with its own TCP connection, shared-token `hello`, reconnect
   state, and event-replay cursor. The map lives in the dynamically-imported
   `init-state` module so it survives Vite dev-server restarts.
2. **TCP transport in `OrcdClient`.** `OrcdClient` currently dials a unix path
   (`~/.orc/orcd.sock`). It gains `{ host, port, token }` and performs the
   `hello` handshake on connect.
3. **Capability aggregation.** On each node's connect/reconnect, query
   `capabilities` and cache per node. Expose the aggregated catalog to the FE
   (which nodes exist, and per node which providers/models).
4. **Routing.** Every card carries a `node_name`. The BE routes that card's
   `create`/`message`/worktree actions to that node's client, and validates the
   card's provider/model against that node's advertised capabilities.
5. **Remove local git/fs.** `src/server/worktree.ts` git execution and
   `setup_commands` execution move to orcd; the BE calls `worktree_prepare`
   instead. Callers: `src/server/sessions/worktree.ts`,
   `src/server/controllers/card-sessions.ts`, `src/server/services/card.ts`,
   `src/server/ws/handlers/sessions.ts`.

## FE changes

1. **Project form** picks a **node** first (from the connected-node list), then
   provider/model constrained to that node's capabilities. `project.path` is
   validated via `path_validate` against the chosen node.
2. **Card create** inherits the project's node/provider/model; node is shown but
   not editable.
3. **Per-node connection status** indicator; a card on an offline node shows
   "node offline / reconnecting" without losing session state.

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

## Data flow

**Project creation:** FE picks node → BE `path_validate` on that node → persist
project with `node_name` + node-constrained provider/model.

**Card → session:** card created with project's `node_name` snapshot → BE looks
up that node's `OrcdClient` → `worktree_prepare` (orcd builds worktree + runs
setup on the box) → `worktree_ready { path }` → BE `create { cwd: path }` →
orcd spawns the agent on the box → events stream back over the node's connection
and forward to the UI as today.

**Inference:** the agent uses the env orcd built from *its* `orcd.yaml`
(`ANTHROPIC_BASE_URL` etc.) — central relay or direct, the BE is uninvolved.

## Resilience (unreliable transport on a node)

A node may have flaky connectivity. Because **orcd owns session lifecycle**, the
agent keeps working on the box while the BE↔node link is down. Mechanisms:

- **Independent per-node reconnect** with backoff (reuses `OrcdClient` reconnect).
  One flaky node never affects others.
- **Lossless catch-up:** on reconnect the BE re-subscribes with
  `subscribe { afterEventIndex }` and orcd replays buffered events.
- **Long-outage backstop:** if the in-memory ring buffer rolls over during an
  extended disconnect, rehydrate missed events from orcd's per-session JSONL
  rather than show gaps. (Ring-buffer size vs. max expected outage is a tuning
  parameter to set explicitly.)
- **UI:** card shows node connection state; session is never torn down due to a
  transport drop — only orcd's authoritative `session_exit` moves a card to
  review.

## Security

- Shared token per node: orcd reads `authToken` from `orcd.yaml`; the BE sends
  the matching token (from `orc.yaml`) in `hello`. Fails closed if the TCP port
  is ever exposed. Tokens are per-node and revocable.
- Prefer binding `listen.host` to the VPN interface and firewalling the port.

## Migration

1. Rename `config.yaml` → `orcd.yaml`; replace `socket:` with `listen:` + add
   `authToken:`. Update `config.example.yaml` → `orcd.example.yaml`.
2. Add `orc.yaml` with a single `local` entry pointing at `127.0.0.1` + token.
3. `ALTER TABLE projects ADD COLUMN node_name TEXT NOT NULL DEFAULT 'local'`.
4. `ALTER TABLE cards ADD COLUMN node_name TEXT NOT NULL DEFAULT 'local'`.
5. Ship orcd's TCP listener + auth; existing local setup keeps working via the
   `local` node.

## Testing strategy

- **orcd:** token auth (accept/reject/close), `capabilities` payload from a
  sample `orcd.yaml`, `worktree_prepare`/`worktree_remove`/`path_validate`
  against a temp git repo, TCP framing parity with previous unix-socket behavior.
- **BE:** multi-client registry lifecycle across simulated Vite restarts;
  routing a card to the correct node; capability validation rejects
  provider/model not advertised by the node; reconnect + `afterEventIndex`
  replay; JSONL rehydrate on ring-buffer overflow.
- **FE:** node-constrained provider/model picker; offline-node card state;
  project-form `path_validate` flow.
- **Integration:** two orcd instances (two ports on `127.0.0.1` standing in for
  two boxes); create projects on each; verify isolation and independent
  reconnect.

## Open questions / future

- Hot-reload of `orc.yaml` (add/remove nodes without BE restart) — nice-to-have.
- Same repo on multiple nodes (would require relaxing the one-project-one-node
  binding) — explicitly out of scope now.
- mTLS upgrade path if nodes ever leave the trusted network.
