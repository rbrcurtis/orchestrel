// Auto-updater for the packaged app. electron-updater is configured in code:
// the github publish config (owner rbrcurtis, repo orchestrel) is the fallback
// and becomes the active feed only in unpackaged/dev runs; in a packaged build
// the config embedded by electron-builder (Task 8's yml) takes precedence, so
// shipping the default here can never shadow it. UPDATER_FEED_OVERRIDE flips
// to a plain http(s) URL (GenericProvider) for local-feed testing — it is an
// ops seam read at call time, not build wiring. Cadence: boot check + 4h
// interval via shouldCheck; the interval timer is unref'd so it never keeps
// the app alive.
//
// The dialog is a plain dialog.showMessageBox from main (not the preload
// bridge): the app is single-window and a modal main-process dialog needs no
// renderer cooperation, which matters because the renderer is the served web
// app we don't want to couple to updater chrome.
import { app, dialog, type BrowserWindow } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { logLine } from './log'

// 4-hour check cadence.
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

// Last successful check timestamp; module state is fine — it resets on
// relaunch, which is the moment we actually want to re-check.
let lastCheckAtMs: number | null = null

export function shouldCheck(lastCheckAtMs: number | null, now: number, intervalMs: number): boolean {
  if (lastCheckAtMs === null) return true
  return now - lastCheckAtMs >= intervalMs
}

// The channel-file name electron-updater fetches for the default "latest"
// channel. Verified against electron-updater 6.8.9 (live run fetched
// "GET /latest-linux.yml"): getChannelFilePrefix() yields "-linux" (no arch
// suffix on x64), "-mac", or "" (win32) — out/providers/Provider.js +
// util.getChannelFilename(channel) => `${ch}.yml`. Matches the plan's naming.
export function updateFeedPath(_version: string, platformArch: string): string {
  if (platformArch.startsWith('linux')) return 'latest-linux.yml'
  if (platformArch.startsWith('darwin')) return 'latest-mac.yml'
  return 'latest.yml'
}

function githubFeed() {
  // Defaults baked in as the fallback; env overrides are an ops seam (dev
  // machines may point elsewhere), read at call time.
  return {
    provider: 'github' as const,
    owner: process.env.UPDATER_OWNER ?? 'rbrcurtis',
    repo: process.env.UPDATER_REPO ?? 'orchestrel',
  }
}

function configureFeed(): void {
  // electron-updater 6.8.9's setFeedURL(string) is broken: it unconditionally
  // wraps ANY string in a GenericProvider config (out/AppUpdater.js) and
  // newBaseUrl() then throws "Invalid URL" — the string path cannot express
  // the github shorthand. Pass the PublishConfiguration object form instead;
  // createClient() routes on the provider field (providerFactory.js).
  // Local-feed override wins over everything; the github feed is the fallback
  // for unpackaged runs only (packaged builds embed the publish config from
  // electron-builder's yml at build time, and calling setFeedURL here would
  // shadow it).
  const override = process.env.UPDATER_FEED_OVERRIDE
  let feed: string
  let options: { provider: 'generic'; url: string } | ReturnType<typeof githubFeed>
  if (override) {
    feed = override
    options = { provider: 'generic', url: override }
  } else if (!app.isPackaged) {
    const f = githubFeed()
    feed = `github ${f.owner}/${f.repo}`
    options = f
  } else {
    void logLine('updater', 'feed: packaged publish config (built in)')
    return
  }
  try {
    autoUpdater.setFeedURL(options)
  } catch (err) {
    // setFeedURL constructs the provider synchronously and throws on an
    // invalid target; a bad feed must never kill boot.
    void logLine('updater', `feed setup failed for ${feed}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  void logLine('updater', `feed: ${feed}`)
}

export function restartForUpdate(): void {
  app.relaunch()
  app.quit()
}

let timer: NodeJS.Timeout | undefined

let mainWindow: BrowserWindow | undefined

export function setUpdaterWindow(win: BrowserWindow): void {
  mainWindow = win
}

export function checkForUpdatesNow(): void {
  if (!app.isPackaged && !process.env.UPDATER_FEED_OVERRIDE) {
    // Unpackaged run without a feed override: there is nothing to update
    // against. Log instead of surfacing electron-updater's dev warning.
    void logLine('updater', 'skipped: dev run without UPDATER_FEED_OVERRIDE')
    return
  }
  if (!shouldCheck(lastCheckAtMs, Date.now(), CHECK_INTERVAL_MS)) {
    void logLine('updater', 'check within cadence; skipping')
    return
  }
  lastCheckAtMs = Date.now()

  void autoUpdater
    .checkForUpdates()
    .then((info) => {
      if (info === null) {
        void logLine('updater', 'no update found')
        return
      }
      void logLine('updater', `update available: ${info.updateInfo.version}`)
      // The window may have been closed between the check and its reply.
      if (mainWindow && !mainWindow.isDestroyed()) {
        void dialog.showMessageBox(mainWindow, {
          title: 'Update available',
          message: `Orchestrel ${info.updateInfo.version} is available`,
          detail: 'Restart now to install it?',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        }).then(({ response }) => {
          if (response === 0) restartForUpdate()
        })
      }
    })
    .catch((err: unknown) => {
      void logLine('updater', `check failed: ${err instanceof Error ? err.message : String(err)}`)
    })
}

export function initUpdater(): void {
  configureFeed()
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Unpackaged linux runs are not AppImages, so v6's AppImageUpdater hard-
  // disables itself (isUpdaterActive → false) — forcing the dev-update config
  // is the only way a local-feed override can ever run an actual check.
  // Safe: guarded to non-packaged by the same condition as the github feed.
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true

  // Mirror electron-updater's internal log (defaults to console, invisible
  // in the packaged app) to main.log so feed selection and check outcomes
  // are inspectable.
  type Lgr = { info: (...p: unknown[]) => void; warn: (...p: unknown[]) => void; error: (...p: unknown[]) => void }
  const lgr = autoUpdater.logger as Lgr
  for (const m of ['info', 'warn', 'error'] as const) {
    const orig = lgr[m].bind(lgr)
    lgr[m] = (...parts: unknown[]) => {
      void logLine('updater', `[${m}] ${parts.join(' ')}`)
      orig(...parts)
    }
  }

  autoUpdater.on('update-available', (info) => void logLine('updater', `available: ${info.version}`))
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    if (Math.round(p.percent) % 25 === 0) void logLine('updater', `downloading ${p.percent.toFixed(1)}%`)
  })
  autoUpdater.on('error', (err) => void logLine('updater', `error: ${err.message}`))
  autoUpdater.on('update-not-available', (info) => void logLine('updater', `not available (feed: ${info.version})`))

  void checkForUpdatesNow()
  timer = setInterval(() => void checkForUpdatesNow(), CHECK_INTERVAL_MS)
  timer.unref()
}
