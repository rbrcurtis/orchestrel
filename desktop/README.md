# Orchestrel Desktop

Self-contained Electron app: seeds a private userData, bundles and supervises
the three services (kpp, orcd, backend) as child node processes, and opens the
Board window on the backend's health URL.

## Building & running

```sh
npm install          # (bun i on hosts where npm is broken)
npm run dev          # bundles + main bundle + electron .
```

## Releasing / auto-update

The app auto-updates from **GitHub Releases** of the public
`rbrcurtis/orchestrel` repository (the repo this code ships from — verify
against `.git/config` if it ever moves).

- `electron-builder` (configured in Task 8's ymls) publishes a release per
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
