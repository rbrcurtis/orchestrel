# Cecil's Orchestrel Instance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a fully isolated second Orchestrel deployment at `cecil.orchestrel.com`, owned by a new Linux user `cecil`, running a production build on port 6196, Ray-provider-only, with CF tunnel + Access OTP and a 3am daily auto-sync from `origin/main`.

**Architecture:** Separate clone of the public repo (`https://github.com/rbrcurtis/orchestrel.git`) owned by `cecil`, with its own `data/`, `config.yaml`, `~/.orc/` socket, Node install, and a service pair (`orcd-cecil`, `orchestrel-cecil`). Shared cloudflared tunnel gets one new ingress route + DNS + Access app. A systemd timer runs a flock-guarded sync script daily at 03:00.

**Tech Stack:** Linux user/systemd, Node 24 via nvm + corepack/pnpm, git, Cloudflare tunnel (`/etc/cloudflared/config.yml`) + Zero Trust Access, sqlite3.

**Reference spec:** `docs/specs/2026-06-19-cecil-orchestrel-instance-design.md`

**Conventions for this plan:**
- Commands prefixed `sudo` run as root. Commands run as cecil use `sudo -u cecil bash -lc '...'` so cecil's login shell (nvm/PATH) is loaded.
- `CECIL_NODE_BIN` = the directory of cecil's pnpm after Node install, i.e. `/home/cecil/.nvm/versions/node/v24.14.1/bin`. Use that literal path in service files.

---

## File / Resource Map

**Created on disk:**
- `/home/cecil/` — new user home
- `/home/cecil/Code/orchestrel/` — Cecil's clone
- `/home/cecil/Code/orchestrel/config.yaml` — Ray-only provider config
- `/home/cecil/Code/orchestrel/data/orchestrel.db` — fresh DB
- `/home/cecil/Code/{cecil,mods,pvp-bot}/` — moved projects
- `/etc/systemd/system/orcd-cecil.service`
- `/etc/systemd/system/orchestrel-cecil.service`
- `/etc/systemd/system/orchestrel-cecil-sync.service`
- `/etc/systemd/system/orchestrel-cecil-sync.timer`
- `/usr/local/bin/sync-orchestrel-cecil`
- `/etc/sudoers.d/orchestrel-cecil`

**Modified:**
- `/etc/cloudflared/config.yml` — add `cecil.orchestrel.com` ingress
- Cloudflare DNS (orchestrel.com zone) — add proxied CNAME
- Cloudflare Zero Trust — Access app for `cecil.orchestrel.com`
- Ryan's `data/orchestrel.db` — remove migrated projects (#11, #12, #16)

---

## Task 1: Create the `cecil` Linux user

**Files:** none (system state)

- [ ] **Step 1: Create the user with home and bash shell**

```bash
sudo useradd -m -s /bin/bash cecil
```

- [ ] **Step 2: Set the password to `greek`**

```bash
echo 'cecil:greek' | sudo chpasswd
```

- [ ] **Step 3: Verify the user exists**

Run: `id cecil && ls -ld /home/cecil`
Expected: prints `uid=...(cecil)` and a home dir owned by `cecil`.

---

## Task 2: Install Node 24 + pnpm for cecil

**Files:** `/home/cecil/.nvm/...` (cecil-owned)

Ryan's nvm node lives under `/home/ryan` (mode 711, unreadable cross-user), so cecil needs his own Node.

- [ ] **Step 1: Install nvm and Node v24.14.1 as cecil**

```bash
sudo -u cecil bash -lc 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'
sudo -u cecil bash -lc 'export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh; nvm install v24.14.1'
```

- [ ] **Step 2: Enable corepack/pnpm**

```bash
sudo -u cecil bash -lc 'export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh; nvm use v24.14.1; corepack enable; corepack prepare pnpm@latest --activate'
```

- [ ] **Step 3: Verify node + pnpm resolve for cecil**

Run: `sudo -u cecil bash -lc 'node -v && which pnpm && pnpm -v'`
Expected: `v24.14.1`, a path under `/home/cecil/.nvm/versions/node/v24.14.1/bin`, and a pnpm version.

> If the node bin path differs from `/home/cecil/.nvm/versions/node/v24.14.1/bin`, use the actual path everywhere this plan says `CECIL_NODE_BIN`.

---

## Task 3: Clone the repo as cecil

**Files:** `/home/cecil/Code/orchestrel/`

- [ ] **Step 1: Create Code dir and clone (public repo, no auth needed)**

```bash
sudo -u cecil bash -lc 'mkdir -p ~/Code && git clone https://github.com/rbrcurtis/orchestrel.git ~/Code/orchestrel'
```

- [ ] **Step 2: Install dependencies**

```bash
sudo -u cecil bash -lc 'cd ~/Code/orchestrel && pnpm install'
```

- [ ] **Step 3: Verify clone + on main**

Run: `sudo -u cecil bash -lc 'cd ~/Code/orchestrel && git branch --show-current && ls package.json'`
Expected: `main` and `package.json` present.

---

## Task 4: Write Cecil's Ray-only config.yaml

**Files:** Create `/home/cecil/Code/orchestrel/config.yaml`

- [ ] **Step 1: Write the config (as cecil, so ownership is correct)**

```bash
sudo -u cecil bash -lc 'cat > ~/Code/orchestrel/config.yaml' <<'YAML'
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
YAML
```

- [ ] **Step 2: Verify it parses as YAML and is owned by cecil**

Run: `sudo -u cecil bash -lc 'cd ~/Code/orchestrel && node -e "console.log(require(\"yaml\").parse(require(\"fs\").readFileSync(\"config.yaml\",\"utf8\")).defaultProvider)"'`
Expected: `ray`

---

## Task 5: Production build

**Files:** `/home/cecil/Code/orchestrel/build/client/` (generated)

- [ ] **Step 1: Build**

```bash
sudo -u cecil bash -lc 'cd ~/Code/orchestrel && pnpm build'
```

- [ ] **Step 2: Verify build output exists**

Run: `sudo -u cecil bash -lc 'ls ~/Code/orchestrel/build/client/index.html'`
Expected: the file path prints (build succeeded).

---

## Task 6: orcd-cecil systemd service

**Files:** Create `/etc/systemd/system/orcd-cecil.service`

- [ ] **Step 1: Write the unit**

```bash
sudo tee /etc/systemd/system/orcd-cecil.service > /dev/null <<'UNIT'
[Unit]
Description=orcd (Cecil) - Claude Code session daemon
After=network.target
Before=orchestrel-cecil.service

[Service]
Type=simple
User=cecil
WorkingDirectory=/home/cecil/Code/orchestrel
ExecStart=/home/cecil/.nvm/versions/node/v24.14.1/bin/pnpm orcd
Environment=NODE_ENV=production
Environment=PATH=/home/cecil/.nvm/versions/node/v24.14.1/bin:/home/cecil/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
```

- [ ] **Step 2: Reload, enable, start**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orcd-cecil
```

- [ ] **Step 3: Verify active + socket created**

Run: `sudo systemctl is-active orcd-cecil && sudo -u cecil bash -lc 'ls ~/.orc/orcd.sock'`
Expected: `active` and the socket path prints.

---

## Task 7: orchestrel-cecil systemd service

**Files:** Create `/etc/systemd/system/orchestrel-cecil.service`

- [ ] **Step 1: Write the unit**

```bash
sudo tee /etc/systemd/system/orchestrel-cecil.service > /dev/null <<'UNIT'
[Unit]
Description=Orchestrel Kanban (Cecil)
After=network.target orcd-cecil.service
Wants=orcd-cecil.service

[Service]
Type=simple
User=cecil
WorkingDirectory=/home/cecil/Code/orchestrel
ExecStart=/home/cecil/.nvm/versions/node/v24.14.1/bin/pnpm start
Environment=NODE_ENV=production
Environment=CF_TEAM_DOMAIN=wednesday-access
Environment=ADMIN_EMAILS=cecilgcurtis@gmail.com,wednesday@gmail.com
Environment=PORT=6196
Environment=PATH=/home/cecil/.nvm/versions/node/v24.14.1/bin:/home/cecil/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
```

- [ ] **Step 2: Reload, enable, start**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orchestrel-cecil
```

- [ ] **Step 3: Verify active + listening on 6196**

Run: `sudo systemctl is-active orchestrel-cecil && curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:6196`
Expected: `active` and an HTTP status (200/302/401 — any response proves it's listening).

> If it fails, check `journalctl -u orchestrel-cecil -n 50`. Confirm port 6196 is free and orcd-cecil is up.

---

## Task 8: Cloudflare tunnel ingress

**Files:** Modify `/etc/cloudflared/config.yml`

- [ ] **Step 1: Add the ingress rule before the catch-all**

Edit `/etc/cloudflared/config.yml`. Immediately before the final `- service: http_status:404` line, insert:

```yaml
  # Cecil's Orchestrel
  - hostname: cecil.orchestrel.com
    service: http://localhost:6196
```

- [ ] **Step 2: Validate config and restart cloudflared**

```bash
sudo cloudflared tunnel ingress validate
sudo systemctl restart cloudflared.service
```

Expected: `validate` reports the config is valid; service restarts cleanly.

- [ ] **Step 3: Verify cloudflared is healthy**

Run: `sudo systemctl is-active cloudflared`
Expected: `active`

---

## Task 9: Cloudflare DNS record

**Files:** none (Cloudflare DNS via API). Key: `/home/ryan/cloudflared/cloudflare.key`, email `wednesday@gmail.com`.

- [ ] **Step 1: Look up the orchestrel.com zone ID**

```bash
CF_KEY=$(cat /home/ryan/cloudflared/cloudflare.key)
curl -s "https://api.cloudflare.com/client/v4/zones?name=orchestrel.com" \
  -H "X-Auth-Email: wednesday@gmail.com" -H "X-Auth-Key: $CF_KEY" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])'
```

Save the printed zone ID as `ZONE_ID` for the next step.

- [ ] **Step 2: Create a proxied CNAME for cecil.orchestrel.com → tunnel**

The tunnel CNAME target is `<tunnel-uuid>.cfargotunnel.com`. Tunnel UUID is `c9e6bfd3-4fee-4870-b3c6-f646607322e9` (from `/etc/cloudflared/config.yml`).

```bash
CF_KEY=$(cat /home/ryan/cloudflared/cloudflare.key)
ZONE_ID=<paste from step 1>
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "X-Auth-Email: wednesday@gmail.com" -H "X-Auth-Key: $CF_KEY" \
  -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"cecil.orchestrel.com","content":"c9e6bfd3-4fee-4870-b3c6-f646607322e9.cfargotunnel.com","proxied":true}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("OK" if d["success"] else d["errors"])'
```

Expected: `OK`. (If it errors with "record already exists", the record is fine — continue.)

- [ ] **Step 3: Verify DNS resolves through Cloudflare**

Run: `dig +short cecil.orchestrel.com`
Expected: Cloudflare proxy IPs (e.g. 104.x / 172.x), not an error.

---

## Task 10: Cloudflare Zero Trust Access app (email OTP)

**Files:** none (Cloudflare Zero Trust). This mirrors the existing `orchestrel.com` Access app.

> `cecilgcurtis@gmail.com` and `wednesday@gmail.com` are already configured identities in CF. This task ensures `cecil.orchestrel.com` is gated by an Access app whose policy allows those two emails via one-time PIN.

- [ ] **Step 1: Check whether an existing Access app already covers the hostname**

In the Cloudflare Zero Trust dashboard → Access → Applications, check for an app whose domain is `cecil.orchestrel.com` or a wildcard `*.orchestrel.com`. If a wildcard app already gates it with the right policy, skip to Step 3.

- [ ] **Step 2: Create a self-hosted Access application**

Create a self-hosted application:
- Application domain: `cecil.orchestrel.com`
- Session duration: match the `orchestrel.com` app (e.g. 24h)
- Policy: Allow, with an **Emails** rule listing `cecilgcurtis@gmail.com` and `wednesday@gmail.com`
- Identity / login method: One-time PIN (email OTP)

(Replicate the exact settings of the existing `orchestrel.com` app for consistency — open it side by side.)

- [ ] **Step 3: Verify the gate works**

In a browser, open `https://cecil.orchestrel.com`.
Expected: Cloudflare Access prompts for email + one-time PIN. Entering `cecilgcurtis@gmail.com` and the emailed PIN loads the Orchestrel board.

---

## Task 11: Move Cecil's three projects into /home/cecil/Code

**Files:** Move dirs; chown to cecil. Sources confirmed: `/home/ryan/Code/cecil/`, `/opt/cecil-minecraft/Code/mods`, `/opt/cecil-minecraft/Code/pvp-bot`.

> Risk: moving the two minecraft dirs removes them from `/opt/cecil-minecraft/Code/`. Step 1 checks for references before deleting; if anything depends on the old paths, a symlink is left behind.

- [ ] **Step 1: Check for references to the old minecraft Code paths**

Run:
```bash
grep -rIl --exclude-dir=.git -e 'Code/mods' -e 'Code/pvp-bot' /opt/cecil-minecraft 2>/dev/null || echo "no references found"
```
If references are found, note them — Step 3 will leave compatibility symlinks.

- [ ] **Step 2: Move the directories**

```bash
sudo mv /home/ryan/Code/cecil /home/cecil/Code/cecil
sudo mv /opt/cecil-minecraft/Code/mods /home/cecil/Code/mods
sudo mv /opt/cecil-minecraft/Code/pvp-bot /home/cecil/Code/pvp-bot
sudo chown -R cecil:cecil /home/cecil/Code/cecil /home/cecil/Code/mods /home/cecil/Code/pvp-bot
```

- [ ] **Step 3: (Only if Step 1 found references) leave compatibility symlinks**

```bash
sudo -u cecil ln -s /home/cecil/Code/mods /opt/cecil-minecraft/Code/mods    # adjust owner/perms as needed
sudo ln -s /home/cecil/Code/pvp-bot /opt/cecil-minecraft/Code/pvp-bot
```
(Skip if Step 1 printed "no references found".)

- [ ] **Step 4: Verify moves**

Run: `ls -ld /home/cecil/Code/cecil /home/cecil/Code/mods /home/cecil/Code/pvp-bot && ls /home/ryan/Code/cecil 2>&1 | head -1`
Expected: the three dirs exist under `/home/cecil/Code` owned by cecil; old `/home/ryan/Code/cecil` is gone.

---

## Task 12: Register Cecil's projects in his DB; remove from Ryan's DB

**Files:** Modify `/home/cecil/Code/orchestrel/data/orchestrel.db` and `/home/ryan/Code/orchestrel/data/orchestrel.db`

> Schema additions/inserts via sqlite3 CLI are safe. NEVER run WAL checkpoint/journal commands.

- [ ] **Step 1: Confirm Cecil's DB exists with a projects table**

Run: `sudo -u cecil bash -lc 'sqlite3 ~/Code/orchestrel/data/orchestrel.db ".tables"'`
Expected: includes `projects` and `cards`. (The app creates these on first boot in Task 7. If missing, restart `orchestrel-cecil` and recheck.)

- [ ] **Step 2: Insert the three projects into Cecil's DB**

The `projects.default_model` column defaults to `sonnet`, which does not exist in Cecil's Ray-only config — so set it explicitly to the Ray model.

```bash
sudo -u cecil bash -lc 'sqlite3 ~/Code/orchestrel/data/orchestrel.db "
INSERT INTO projects (name, path, provider_id, default_model) VALUES (\"Cecil\", \"/home/cecil/Code/cecil\", \"ray\", \"qwen3.6-27b-coder\");
INSERT INTO projects (name, path, provider_id, default_model) VALUES (\"Minecraft Mods\", \"/home/cecil/Code/mods\", \"ray\", \"qwen3.6-27b-coder\");
INSERT INTO projects (name, path, provider_id, default_model) VALUES (\"Minecraft PvP Bot\", \"/home/cecil/Code/pvp-bot\", \"ray\", \"qwen3.6-27b-coder\");
"'
```

- [ ] **Step 3: Verify Cecil's projects**

Run: `sudo -u cecil bash -lc 'sqlite3 ~/Code/orchestrel/data/orchestrel.db "SELECT id,name,path,provider_id,default_model FROM projects;"'`
Expected: the three rows with `ray` provider, `qwen3.6-27b-coder` model, and `/home/cecil/Code/...` paths.

- [ ] **Step 4: Remove the migrated projects from Ryan's DB**

These projects now live with Cecil. Remove rows #11 (Minecraft Mods), #12 (Minecraft PvP Bot), #16 (Cecil) from Ryan's DB. Cards referencing them have `project_id` set to NULL via `ON DELETE SET NULL`.

```bash
sqlite3 /home/ryan/Code/orchestrel/data/orchestrel.db "DELETE FROM projects WHERE id IN (11,12,16);"
```

- [ ] **Step 5: Verify removal**

Run: `sqlite3 /home/ryan/Code/orchestrel/data/orchestrel.db "SELECT id,name FROM projects WHERE id IN (11,12,16);"`
Expected: no rows.

---

## Task 13: Sync script + sudoers

**Files:** Create `/usr/local/bin/sync-orchestrel-cecil`, `/etc/sudoers.d/orchestrel-cecil`

- [ ] **Step 1: Write the sync script**

```bash
sudo tee /usr/local/bin/sync-orchestrel-cecil > /dev/null <<'EOF'
#!/usr/bin/env bash
set -ex

export NVM_DIR=/home/cecil/.nvm
. "$NVM_DIR/nvm.sh"
nvm use v24.14.1

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
pnpm build
sudo systemctl restart orcd-cecil orchestrel-cecil
EOF
sudo chmod 755 /usr/local/bin/sync-orchestrel-cecil
```

- [ ] **Step 2: Grant cecil passwordless sudo for the restart only**

```bash
sudo tee /etc/sudoers.d/orchestrel-cecil > /dev/null <<'EOF'
cecil ALL=(root) NOPASSWD: /usr/bin/systemctl restart orcd-cecil orchestrel-cecil
EOF
sudo chmod 440 /etc/sudoers.d/orchestrel-cecil
sudo visudo -c
```

Expected: `visudo -c` reports the sudoers files are OK.

- [ ] **Step 3: Dry-run the sync as cecil (should be a no-op when up to date)**

```bash
sudo -u cecil bash -lc 'flock -n /tmp/orchestrel-cecil-sync.lock /usr/local/bin/sync-orchestrel-cecil'
```

Expected: prints `already up to date` (or performs a reset+build+restart if behind), exits 0.

---

## Task 14: Daily 3am timer

**Files:** Create `/etc/systemd/system/orchestrel-cecil-sync.service`, `/etc/systemd/system/orchestrel-cecil-sync.timer`

- [ ] **Step 1: Write the oneshot sync service**

```bash
sudo tee /etc/systemd/system/orchestrel-cecil-sync.service > /dev/null <<'UNIT'
[Unit]
Description=Sync Cecil's Orchestrel to origin/main and rebuild
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=cecil
ExecStart=/usr/bin/flock -n /tmp/orchestrel-cecil-sync.lock /usr/local/bin/sync-orchestrel-cecil
UNIT
```

- [ ] **Step 2: Write the daily 3am timer**

```bash
sudo tee /etc/systemd/system/orchestrel-cecil-sync.timer > /dev/null <<'UNIT'
[Unit]
Description=Daily 3am sync of Cecil's Orchestrel

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
```

- [ ] **Step 3: Reload, enable, start the timer**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orchestrel-cecil-sync.timer
```

- [ ] **Step 4: Verify the timer is scheduled for 03:00**

Run: `systemctl list-timers orchestrel-cecil-sync.timer --all`
Expected: a row showing the next trigger at the upcoming 03:00.

- [ ] **Step 5: Verify the sync service runs manually**

```bash
sudo systemctl start orchestrel-cecil-sync.service
journalctl -u orchestrel-cecil-sync.service -n 20 --no-pager
```

Expected: log shows `already up to date` or a successful reset/build/restart; unit result is success.

---

## Task 15: End-to-end verification

**Files:** none

- [ ] **Step 1: Both Cecil services active and isolated from Ryan's**

Run: `sudo systemctl is-active orcd-cecil orchestrel-cecil orchestrel orcd`
Expected: all `active`. Ryan's `orchestrel` still on 6194, Cecil's on 6196.

- [ ] **Step 2: Local app responds on 6196**

Run: `curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:6196`
Expected: an HTTP status (listening).

- [ ] **Step 3: Public hostname gated by Access**

In a browser open `https://cecil.orchestrel.com` → CF Access OTP → log in with `cecilgcurtis@gmail.com`. The board loads and shows the three projects.

- [ ] **Step 4: Card uses Ray provider**

Create a card on Cecil's board and confirm the provider/model selector defaults to Ray / `qwen3.6-27b-coder`, and a run reaches the Ray gateway.

- [ ] **Step 5: Confirm Ryan's instance unaffected**

Open `https://orchestrel.com` (port 6194) and confirm it loads normally and no longer lists the three migrated projects.

---

## Post-Implementation: store memory

After verification, record the deployment in shared memory (infrastructure fact): Cecil's Orchestrel — user `cecil`, `/home/cecil/Code/orchestrel`, port 6196, services `orcd-cecil`/`orchestrel-cecil`, host `cecil.orchestrel.com` (Access OTP for cecilgcurtis@gmail.com + wednesday@gmail.com), Ray-only provider, daily 3am sync via `orchestrel-cecil-sync.timer` + `/usr/local/bin/sync-orchestrel-cecil`.
