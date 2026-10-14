# Orchestrel Desktop

Self-contained Electron app: seeds a private userData, bundles and supervises
the three services (kpp, orcd, backend) as child node processes, and opens the
Board window on the backend's health URL.

## Building & running (dev loop)

```sh
bun i                # npm is broken on some hosts; bun is the source of truth
npm run dev          # = bundles (node runtime + sqlite prebuild + SPA) + main bundle + electron .
```

`npm run dev` (and the `build:*` scripts) orchestrate the whole chain from
`desktop/`:

1. `node build-bundles.mjs` — esbuild the three service bundles + download the
   pinned Node runtime into `out/node/` + the plain-node `better-sqlite3`
   prebuild into `out/node_modules/` + copy the SPA to `out/client/`. Pass
   `--platform linux-x64|linux-arm64|mac-arm64|win-x64` to build the embedded
   runtime for a NON-HOST target (a mac build on `oni` fetches darwin/arm64
   node; a win build fetches the node.exe tarball + the win prebuild). The
   bundles themselves are platform-independent JS; only the embedded runtime
   and the native addon vary.
2. `node build-main.mjs` — bundle `main/*.ts` → `dist/main.cjs` + preloads +
   `provision-dll-bundle.cjs` (copied into `out/` by the bundle step, so this
   must run BEFORE it in a from-scratch build — the scripts order them right).
3. `electron .` — boots in dev mode (`ELECTRON_IS_ASAR` unset, `app.isPackaged`
   false) and resolves `out/` as a sibling of `dist/`.

Frontend changes: the SPA is rebuilt by `bun run build` at the repo root
(which `build-bundles` requires to have run). Re-run `npm run dev` after a SPA
or bundle change; main-process TS changes HMR-less (re-run the script).

Tests: `npm run test` (vitest — supervisor, seed, shim, build+boot smoke,
main mappings, updater logic, resolveOutDir). `npm run typecheck` (tsc -b).

## Kiro CLI (login / status / logout / refresh)

The desktop app installs a stable `~/.local/bin/orchestrel` shim (Windows:
`%LocalAppData%/orchestrel/orchestrel.cmd`) that runs the bundled node +
`kpp.bundle.mjs` against the app's Kiro config, so you can manage Kiro
accounts **with the app closed**. The shim is repaired (re-copied) on every
launch when the bundled node/bundle/addon changed.

```sh
orchestrel login local      # device-code flow: prints a URL + user code
orchestrel status           # pool accounts, health, usage, token expiry
orchestrel logout local [email]
orchestrel refresh [pool]   # force a token refresh
```

`login` prints

```
Open this URL and authorize:
  https://trackable.awsapps.com/start/#/device?user_code=XXXX-XXXX
Code: XXXX-XXXX
```

open the URL, authorize in the browser. `Ctrl-C` during the wait aborts
**cleanly** — no half-written account is committed (verified: accounts.db
row count is unchanged after an interrupted login). Token expiry: Kiro's
tokens are short-lived; when AWS returns an expiry error the proxy surfaces it
verbatim (no silent retry) and the account shows `EXPIRED` in `status` until
`refresh` or `login` again.

## Releasing / packaging

`scripts/package-desktop.sh` (repo root) builds one platform and optionally
creates the GitHub release:

```sh
scripts/package-desktop.sh --target linux|mac|win --version X.Y.Z [--release] [--publish]
```

Flow: stamp `desktop/package.json` version → `bun run build` (SPA) →
`build-bundles.mjs --platform <target>` (embedded runtime for that platform)
→ `build-main.mjs` → `electron-builder --config desktop/electron-builder-<t>.yml
--publish never` → (with `--release`) `gh release create vX.Y.Z <artifacts>`.

- `--release` defaults to a **draft**; add `--publish` to make it public
  (public is what makes the auto-update feed live to other machines). Requires
  `GH_TOKEN` in the environment.
- `--target linux` builds BOTH x64 and arm64. The embedded node/sqlite runtime
  is built for the **host** arch by default, so smoke-test the x64 artifact on
  an x64 box; to also get a correct arm64 embedded runtime, re-run
  `build-bundles.mjs --platform linux-arm64` before packaging.
- `--target mac` builds arm64 only (see "macOS build on oni" below).
- `--target win` builds an NSIS x64 installer.

The three `desktop/electron-builder-{linux,mac,win}.yml` are the single source
of build config. Key decisions (full rationale in each yml + task-8 report):

- `files: [dist/**, out/**, '!node_modules']` + `asarUnpack: [out/**]`. The
  whole `out/` tree is unpacked because **every** file in it is exec'd or
  require'd by the BUNDLED plain node (provision-db.cjs, the three service
  bundles, `out/node/node`, the `.node` addon) — plain node cannot read a
  packed asar. Only `dist/` (the electron main bundle) and `package.json`
  stay packed. `!node_modules` keeps the repo-root node_modules out of the
  asar.
- `directories.output: release` — the builder output MUST not sit in a dir
  `files:` matches (the main-bundle `dist/` collision caused ~6GB asars on
  rebuild).
- `asar.smartUnpack: false` — only the explicit `out/**` unpack is honored.
- `publish: {provider: github, owner: rbrcurtis, repo: orchestrel}` — bakes
  `app-update.yml` into the packaged build so the runtime updater works with no
  env overrides (this closes Task 7's "packaged build has no feed until Task
  8"). Must match `.git/config`'s origin.

Artifacts (in `desktop/release/`):
- linux: `Orchestrel-X.AppImage` (+ `-arm64`), `orchestrel-desktop_X_<arch>.deb`,
  `latest-linux.yml` / `latest-linux-arm64.yml`
- mac: `Orchestrel-X.dmg`, `Orchestrel-X.zip`, `latest-mac.yml`
- win: `Orchestrel Setup X.exe`, `latest.yml`

## Releasing / auto-update

The app auto-updates from **GitHub Releases** of the public
`rbrcurtis/orchestrel` repository (the repo this code ships from — verify
against `.git/config` if it ever moves).

- `electron-builder` (configured in the three ymls) publishes a release per
  tag; the release's assets must carry the platform channel files the
  updater requests, which electron-updater 6 derives as
  `latest.yml` (win32), `latest-linux.yml` (linux x64), `latest-mac.yml`
  (darwin). `main/updater.ts:updateFeedPath` mirrors that derivation and the
  unit tests pin it.
- At boot (and every 4 h) `autoUpdater.checkForUpdates()` fetches the feed;
  `autoDownload = true` downloads the artifact on offer; `autoInstallOnAppQuit
  = true` applies the pending update on the next quit. A modal
  "Restart now / Later" dialog (main-process `dialog.showMessageBox`, so it
  needs no renderer cooperation) offers the immediate relaunch.
- Ops seams, read at runtime in main: `UPDATER_OWNER` / `UPDATER_REPO`
  override the GitHub feed (dev builds only — packaged builds use the
  electron-builder-baked publish config), and
  `UPDATER_FEED_OVERRIDE=http://host:port` points the updater at a static
  directory serving `latest-<platform>.yml` for local testing.

  Local test recipe: `python3 -m http.server` over a dir containing a
  `latest-linux.yml` with a version one past `package.json`'s and a
  `files:` list, then `UPDATER_FEED_OVERRIDE=http://127.0.0.1:PORT` and boot.

- Verified electron-updater 6.8.9 behaviors (see task-7 report):
  - `setFeedURL(string)` is broken in v6 — it forces a GenericProvider for
    any string and throws `Invalid URL` on non-URL input. Code always passes
    the publish-config object form (`{provider:'github'|'generic',...}`).
  - Linux unpackaged runs are not AppImages, so `AppImageUpdater` disables
    itself; `forceDevUpdateConfig = true` (set for unpackaged runs) is what
    lets a dev/local-feed check run at all.

## macOS build on `oni`

`oni` is an Apple-Silicon Mac. Node lives under a login-shell-managed path, so
invoke it through a login shell. Disable identity discovery (ad-hoc, no paid
Apple Developer account needed):

```sh
ssh oni 'zsh -lic "cd <path>/orchestrel && \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  scripts/package-desktop.sh --target mac --version X.Y.Z"'
```

`CSC_IDENTITY_AUTO_DISCOVERY=false` + `identity: null` in the mac yml produce
an **ad-hoc-signed** build. Consequences (accept them or get a real cert):
- Gatekeeper distrusts each new build. First launch per version: **right-click
  the app → Open** (or `xattr -dr com.apple.quarantine /Applications/Orchestrel.app`).
- Trust is reset for every new version number — there is no persistent
  "Open Anyway" once the version changes.
- A proper Developer ID certificate (paid) + notarization removes the
  right-click dance. Until then, ad-hoc is the floor that makes the app run.

The mac build is **not** smoke-tested on a Linux host (no darwin runtime to
exec); it is verified by inspection only. Build it on `oni` and run the mac
smoke checklist there.

## Windows build

`scripts/package-desktop.sh --target win --version X.Y.Z` produces
`Orchestrel Setup X.exe` (NSIS) + `latest.yml`. The build works on a Windows
box (or Windows-in-WSL with wine for the bundler step is **not** recommended —
use a real Windows host / CI). `build-bundles.mjs --platform win-x64` fetches
the `node.exe` tarball and the win-x64 `better-sqlite3` prebuild.

SmartScreen: an unsigned / ad-hoc-signed `.exe` triggers a Windows
SmartScreen warning ("Windows protected your PC"). Click **More info → Run
anyway** until the build is signed with an EV/Code-Signing cert. Document this
for any non-developer recipient.

## Smoke checklists

### Linux (run here on the build box — the actual AppImage)

1. **Launches + board 200** — `xvfb-run -a <AppImage> --no-sandbox`, then
   `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<backendPort>/`
   (port from `~/.config/orchestrel-desktop/bootstrap.json`). Expect `200`
   text/html. `logs/main.log` shows `services healthy`.
2. **Shim** — `~/.local/bin/orchestrel status` prints the `local` pool (the
   shim was repaired on launch).
3. **Kiro login abort is clean** — `orchestrel login local` prints the device
   URL + code; `Ctrl-C` leaves `orchestrel status` at 0 accounts (no
   half-written row).
4. **No orphans after a hard kill** — `kill -9` the electron main; the three
   service children may briefly survive (Electron does not run JS signal /
   exit handlers for SIGKILL). **Relaunch**: boot logs `swept N orphaned
   service pid(s)` and the port is freed — the pid-file sweep reaps them.
   Graceful quit (close the window / menu Quit) → `before-quit` →
   `supervisor.stop()` kills all three with no orphans and clears the pid
   file.
5. **`.deb` variant boots** — `dpkg -i orchestrel-desktop_X_amd64.deb` (needs
   root) OR extract (`dpkg-deb -x <deb> /tmp/d`) and run
   `/tmp/d/opt/Orchestrel/orchestrel-desktop --no-sandbox` under xvfb. Same
   userData → same `backendPort`, board 200.
6. **Human-side (needs a real display + a real Kiro account):**
   - complete a real `orchestrel login local` in a browser
   - run a Kiro-provider card end to end: board shows the stream, the card
     moves to `review` on session exit
   - quit + relaunch: the DB (`orchestrel.db`) and the Kiro accounts
     (`kiro/accounts.db`) persist

### macOS (on `oni`)

- launch from `/Applications/Orchestrel.app` (right-click → Open on first run
  per version)
- board 200 via the window; `~/Library/Application Support/Orchestrel` is the
  userData
- `~/.local/bin/orchestrel status` (mac path)
- real Kiro login + a Kiro card to review; quit/relaunch persistence

### Windows

- run `Orchestrel Setup X.exe` (SmartScreen: More info → Run anyway)
- `%LocalAppData%/orchestrel/orchestrel.cmd status`
- real Kiro login + a Kiro card to review; quit/relaunch persistence

## Update-feed ops

Feeds live as GitHub-release assets on the **public** repo. A build only shows
up to other machines after the release is **published** (not a draft). Draft
releases are invisible to the updater. To push an update: build all targets at
the same version, `--release --publish`, and every installed app picks it up
within its 4 h check (or immediately via Help → "Check for updates now").
