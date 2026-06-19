# Cecil's Orchestrel Instance — Design

**Date:** 2026-06-19
**Goal:** Give Cecil his own fully isolated Orchestrel system at `cecil.orchestrel.com` that does not collide with Ryan's instance, runs as Linux user `cecil`, uses only the Ray provider, and auto-syncs code from `origin/main` daily.

## Summary

Stand up a second, independent Orchestrel deployment owned by a new Linux user `cecil`:

- New Linux user `cecil` (password `greek`), home `/home/cecil`.
- Separate clone of the repo at `/home/cecil/Code/orchestrel`, tracking `origin/main`.
- Separate runtime state: own `data/`, `config.yaml`, `~/.orc/` socket.
- Own service pair (`orcd-cecil`, `orchestrel-cecil`) on port `6196`.
- Cloudflare tunnel ingress + Zero Trust Access (email OTP) for `cecil.orchestrel.com`, plus an un-gated `hmr.cecil.orchestrel.com` for Vite HMR.
- Daily systemd timer that resets the clone to `origin/main`, reinstalls deps, and restarts Cecil's services.
- Cecil's three existing projects physically **moved** into `/home/cecil/Code/`.

## Why a separate clone (not a shared worktree)

A git worktree sharing Ryan's object store was considered, but worktrees require write access to the main repo's `.git/worktrees` metadata. Across separate Linux users that means `cecil` would need write access into `/home/ryan`, breaking isolation. A separate clone owned by `cecil` is the clean boundary. Cost: one extra checkout + `node_modules`.

## Isolation Matrix

| Concern | Ryan | Cecil |
|---|---|---|
| Linux user | `ryan` | `cecil` |
| Checkout | `/home/ryan/Code/orchestrel` | `/home/cecil/Code/orchestrel` |
| HTTP port | `6194` | `6196` |
| orcd socket | `~/.orc/orcd.sock` (ryan home) | `~/.orc/orcd.sock` (cecil home) |
| DB / data | `data/` in ryan checkout | `data/` in cecil checkout |
| config.yaml | full provider set | Ray only |
| Services | `orcd`, `orchestrel` | `orcd-cecil`, `orchestrel-cecil` |
| Public host | `orchestrel.com` | `cecil.orchestrel.com` |
| HMR host | `hmr.orchestrel.com` | `hmr.cecil.orchestrel.com` |
| Access OTP | `wednesday@gmail.com` | `cecilgcurtis@gmail.com` + `wednesday@gmail.com` |

## Components

### 1. Linux user `cecil`

- Create user `cecil` with password `greek`, home `/home/cecil`, shell `/bin/bash` (or match system default).
- Install Node `v24.14.1` + `pnpm` (via corepack) for `cecil`. Ryan's nvm node lives under `/home/ryan` (mode `711`, not readable by others), so `cecil` needs his own Node install. Install nvm into `/home/cecil/.nvm` and `nvm install v24.14.1`, then `corepack enable`.

### 2. Code: separate clone

- Clone the Orchestrel repo to `/home/cecil/Code/orchestrel`, owned by `cecil`, tracking `origin/main`.
  - Source remote: the same `origin` Ryan's checkout uses (look it up via `git -C /home/ryan/Code/orchestrel remote get-url origin`).
- Run `pnpm install` once after clone.
- These files are gitignored and must be created in the clone (not provided by git): `config.yaml`, `data/`. `CLAUDE.md` is also gitignored — not required for runtime.

### 3. Cecil's `config.yaml`

Ray provider only. No Claude credentials are needed because Ray is a local gateway.

```yaml
socket: ~/.orc/orcd.sock
defaultProvider: ray
defaultModel: qwen3.6-27b-coder
defaultCwd: ~/Code

providers:
  ray:
    label: Ray
    baseUrl: http://127.0.0.1:11434/v1
    authToken: ray
    models:
      "qwen3.6-27b-coder": { label: "Qwen3.6 27B Coder", modelID: qwen3.6-27b-coder, contextWindow: 240000 }
```

- `memoryUpsert` is intentionally omitted (that is Ryan's memory service + key).
- Ray gateway runs at `127.0.0.1:11434` on the same host, so Cecil's agents reach it directly.

### 4. Database

- Cecil starts with a fresh `data/orchestrel.db` (schema is created by the app on first boot; if the app does not auto-create, initialize from the schema in `CLAUDE.md`).
- After first boot, register Cecil's three projects (see section 7). Cecil's `users` table should include `cecilgcurtis@gmail.com` (and `wednesday@gmail.com`) as admin, matching `ADMIN_EMAILS`.

### 5. Systemd services

Mirror Ryan's two units, adjusted for user/paths/port. `.service` files are gitignored, so they live only in `/etc/systemd/system/`.

`orcd-cecil.service`:
- `User=cecil`
- `WorkingDirectory=/home/cecil/Code/orchestrel`
- `ExecStart=<cecil node bin>/pnpm orcd`
- `Environment=NODE_ENV=production`
- `Environment=PATH=<cecil node bin>:/usr/local/bin:/usr/bin:/bin`
- `Restart=always`, `RestartSec=3`
- `Before=orchestrel-cecil.service`

`orchestrel-cecil.service`:
- `User=cecil`
- `WorkingDirectory=/home/cecil/Code/orchestrel`
- `ExecStart=<cecil node bin>/pnpm dev`
- `Environment=NODE_ENV=development`
- `Environment=CF_TEAM_DOMAIN=wednesday-access`
- `Environment=ADMIN_EMAILS=cecilgcurtis@gmail.com,wednesday@gmail.com`
- `Environment=PORT=6196`
- `Environment=HMR_HOST=hmr.cecil.orchestrel.com`
- `Environment=PATH=<cecil node bin>:/usr/local/bin:/usr/bin:/bin`
- `Restart=on-failure`
- `After=network.target orcd-cecil.service`, `Wants=orcd-cecil.service`

Enable both (auto-start on boot).

### 6. Cloudflare tunnel + Access

Reuse the existing shared tunnel (`/etc/cloudflared/config.yml`, tunnel `c9e6bfd3-...`).

- Add ingress rules (before the catch-all `http_status:404`):
  - `cecil.orchestrel.com → http://localhost:6196`
  - `hmr.cecil.orchestrel.com → http://localhost:6196`
- `sudo systemctl restart cloudflared.service`.
- DNS (orchestrel.com zone, via CF API; key at `/home/ryan/cloudflared/cloudflare.key`):
  - Proxied CNAME `cecil.orchestrel.com` → tunnel.
  - Proxied CNAME `hmr.cecil.orchestrel.com` → tunnel.
- Cloudflare Zero Trust Access app on `cecil.orchestrel.com`:
  - Email OTP policy allowing `cecilgcurtis@gmail.com` and `wednesday@gmail.com` (both already configured in CF).
  - No Access app on `hmr.cecil.orchestrel.com` (Vite HMR WebSocket bypass, matching how `hmr.orchestrel.com` is left un-gated).

### 7. Move Cecil's projects

Physically **move** these three into `/home/cecil/Code/`, then chown to `cecil`:

| Current path | New path |
|---|---|
| `/home/ryan/Code/cecil/` | `/home/cecil/Code/cecil/` |
| `/opt/cecil-minecraft/Code/mods` (`/home/ryan/Code/minecraft/mods`) | `/home/cecil/Code/mods` |
| `/opt/cecil-minecraft/Code/pvp-bot` (`/home/ryan/Code/minecraft/pvp-bot`) | `/home/cecil/Code/pvp-bot` |

- After moving, register them as projects in Cecil's DB.
- Remove the corresponding projects from Ryan's DB (`#11 Minecraft Mods`, `#12 Minecraft PvP Bot`, `#16 Cecil`) since they no longer live under his tree.
- **Risk acknowledged:** moving the two Minecraft dirs removes them from `/opt/cecil-minecraft/Code/`. If anything in the running minecraft setup references those paths, it will break. Ryan chose move (option B) knowingly. Verify nothing in `/opt/cecil-minecraft` actively depends on `Code/mods` or `Code/pvp-bot` before deleting originals; if uncertain, leave a symlink from the old path to the new location.

### 8. Daily auto-sync

Script `/usr/local/bin/sync-orchestrel-cecil` (runs as `cecil`):

```bash
#!/usr/bin/env bash
set -ex

REPO=/home/cecil/Code/orchestrel
cd "$REPO"

git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "already up to date"
  exit 0
fi

git reset --hard origin/main
pnpm install --frozen-lockfile
sudo systemctl restart orcd-cecil orchestrel-cecil
```

- Wrap invocation with `flock -n /tmp/orchestrel-cecil-sync.lock` to prevent overlap.
- No `pnpm build` step: the service runs `pnpm dev` (HMR), matching Ryan's setup.
- `cecil` needs passwordless sudo for exactly the restart command. Add a sudoers drop-in `/etc/sudoers.d/orchestrel-cecil`:
  - `cecil ALL=(root) NOPASSWD: /usr/bin/systemctl restart orcd-cecil orchestrel-cecil`

Systemd timer `orchestrel-cecil-sync.timer` (daily) + `orchestrel-cecil-sync.service` (oneshot, `User=cecil`, runs the flock-wrapped script). Logs to journald.

## Out of Scope (for now)

- DB backups for Cecil (Ryan's `scripts/backup-db.sh` is ryan-specific; can be replicated later).
- LAN/no-auth access host for Cecil (Ryan has `dispatch.rbrcurtis.com`; not requested for Cecil).
- Any code changes to Orchestrel itself — this is purely deployment/infra.

## Verification

1. `sudo systemctl status orcd-cecil orchestrel-cecil` → both active.
2. `curl -sS localhost:6196` returns the app.
3. `https://cecil.orchestrel.com` prompts CF Access OTP; OTP to `cecilgcurtis@gmail.com` logs in.
4. HMR works through the tunnel (edit a frontend file in Cecil's clone, see live update).
5. Cecil's board shows his three projects; creating a card uses the Ray provider/model.
6. Trigger sync manually (`sudo -u cecil sync-orchestrel-cecil`) and confirm reset + restart.
7. Confirm Ryan's instance (`orchestrel.com`, port 6194) is unaffected.
