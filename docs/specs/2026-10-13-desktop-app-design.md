# Orchestrel Self-Contained Desktop App — Design

> **Superseded in part (2026-10-15):** KPP is no longer bundled, spawned, or
> seeded, and the `orchestrel kiro` shim is removed. The app ships no provider
> until one is configured in `<userData>/orcd.yaml`. See `desktop/README.md`.

## Summary

Replace the thin Electron wrappers in `desktop/` (windows pointed at
`https://orchestrel.com`) with a single, fully self-contained desktop app that
embeds the entire Orchestrel stack — React client, backend (Express +
socket.io + SQLite), orcd, and its own Kiro proxy (kiro-pool-proxy). A
recipient installs one package per OS and the app just runs, no external
infrastructure.

## Decisions (agreed)

- **Provider:** Kiro only for v1. Provider plumbing stays generic; Anthropic
  direct/Claude Max comes later.
- **Topology:** single machine. Local orcd + local DB per install. No remote
  orcd node support in the distributed app.
- **Distribution:** informal to start (GitHub Releases on the existing public
  orchestrel repo) but with built-in auto-update from day one.
- **Kiro auth:** CLI-based. No onboarding wizard, no in-app auth panel.
- **Architecture:** Electron supervisor + bundled coprocesses (approach A).

## Process Model

The Electron main process is a thin supervisor. On launch it:

1. Resolves the `userData` dir and seeds first-run defaults: `orcd.yaml`, KPP
   `config.json` + Kiro accounts dir, DB parent dir. (Pi agent dir: decided
   2026-10-14 to SHARE the operator's global `~/.pi/agent` rather than seed a
   copy — orcd slash commands work out of the box because the real prompts/
   skills are present.)
2. Picks free ports and writes a `bootstrap.json` (ports + auth token) into
   `userData`.
3. Spawns, in order, each on a **bundled plain Node binary**
   (`resources/node`, real Node — not Electron's ABI):
   - KPP: `node kpp.bundle.cjs serve`
   - orcd: `node orcd.bundle.cjs` (socket per its config)
   - backend: `node server.bundle.mjs` (production branch: Express, socket.io,
     static SPA, better-sqlite3)
4. Waits for the backend health endpoint, then creates the BrowserWindow at
   `http://127.0.0.1:<port>`.
5. Watches children. Rate-limited respawn (N per M minutes); exceeding it shows
   an error window with the relevant log tail plus Quit / Restart services.
   App quit tears down all children.

Key facts enabling this: orcd runs the Pi agent **in-process** via the
`@earendil-works/pi-coding-agent` SDK (no separate agent binary to ship), and
KPP already has `serve` and `login` commands.

Bundling: an esbuild step produces `server.bundle.mjs`, `orcd.bundle.cjs`, and
`kpp.bundle.cjs` from the existing TS sources — no runtime tsx, no Vite/dev
path in the app. The built SPA (`build/client`) ships as a static resource.
`better-sqlite3` ships as a native addon prebuilt for plain Node per
platform/arch.

## Kiro Integration

- KPP sources stay in `~/Code/kiro-pool-proxy`; the desktop build consumes
  them as a local dependency pinned in the build script (repos stay
  independent, one source of truth).
- Kiro state lives in the app's `userData/kiro/` (accounts SQLite + pools),
  never in the user's global `~/.config/kiro-auth` — no collision with a
  separate personal KPP install.
- **Auth is a CLI:** `orchestrel kiro login` (bundled shim = KPP CLI with home
  pointed at the app's `userData/kiro/`). Device-code flow: prints verification
  URL + user code, user completes in browser. Works with the app closed.
  `status` / `logout` / `refresh` exposed the same way. On first launch the app
  installs a small idempotent `orchestrel` shim into `~/.local/bin` (prints the
  install path if it isn't on the user's PATH).
- Seeded `orcd.yaml` contains a generic `kiro` provider: `baseUrl` = the
  bundled KPP's localhost port, `apiKey` = the local pool name. Nothing
  Kiro-specific lives in orcd or the backend.
- Zero accounts → cards fail fast with an actionable error: "No Kiro accounts
  logged in — run `orchestrel kiro login`".

## Packaging, Auto-Update, Signing

- electron-builder targets:
  - macOS: `.dmg` + `.zip`, arm64, built on `oni`, ad-hoc signed (right-click →
    Open per version).
  - Linux: `.AppImage` + `.deb`, unsigned.
  - Windows: `.nsis`, unsigned (SmartScreen warning expected).
- Auto-update: `electron-updater`, GitHub provider, releases on the existing
  public orchestrel repo. Upload step publishes per-platform artifacts +
  `latest*.yml` with each release; version bumped in one place and stamped
  into the feed. In-app "Update available → Download & install".
- Accepted informal-distribution caveats: macOS permission resets on
  re-sign, one manual Open per version; SmartScreen on Windows.
- One version number covers client + backend + orcd + KPP; the update feed is
  the only update path (no partial updates).

## First Run, Data, Logging

- No wizard. First launch opens the normal board; first use flows are the
  existing ones (add project via folder picker, pick the kiro provider). The
  only new first-use step is `orchestrel kiro login` from a terminal — linked
  from the kiro-provider error and documented in README/help.
- Single local user: the `users` table gets one seeded row. No auth.
- Everything under `userData`: DB, `orcd.yaml`, Kiro state, logs. (Pi agent
  dir: decided 2026-10-14 to keep the operator's global `~/.pi/agent` — a
  seeded copy would shadow the operator's real prompts/skills/extensions.)
  Projects are local paths; worktree/multi-repo flows work unchanged.
- Logs: each child's stdout/stderr to rotating files under `userData/logs/`.
  Menu item "Open logs folder"; the crash window links the relevant file.
- Error-handling principle: every failure states the problem, the fix, and
  whether anything needs re-doing (e.g. "Kiro proxy crashed, restarting… cards
  paused, nothing lost"; "another Orchestrel is running on this machine").

## Repo Layout & Pipeline

- `desktop/` rewritten as the self-contained app:
  - `desktop/main/` — Electron main + preload (supervisor, window, updater,
    menu, `orchestrel` CLI shim resources).
  - `desktop/build-bundles.mjs` — esbuild: `server.bundle.mjs`,
    `orcd.bundle.cjs`, `kpp.bundle.cjs` + `better-sqlite3` prebuild.
  - `desktop/electron-builder.<target>.yml` — per-platform configs.
- `scripts/package-desktop.sh` — `bun run build` (SPA) → bundles → native
  prebuilds → electron-builder → GitHub Release upload (GH token). Linux
  targets from the Linux box; mac targets from `oni`.

## Testing

- vitest for the new logic: supervisor (spawn order, health check, respawn
  cap, teardown), first-run seeding, bootstrap file generation, updater
  config.
- Bundled services are unchanged code — covered by their existing suites.
- Manual smoke checklist per platform documented in the desktop README.

## Out of Scope (v1)

- Anthropic provider support, remote orcd nodes, code signing/notarization,
  multiple local users, mobile.
