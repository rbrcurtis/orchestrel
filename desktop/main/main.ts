// Electron entry for the self-contained desktop app. Thin imperative boot,
// top to bottom: single-instance lock → seed userData → provision the DB base
// tables (bundled-node child) → install CLI shim → start the Supervisor (kpp,
// orcd, backend as child node processes) → open the main window on the
// backend's health URL → wire the crash window → tear down on quit. This
// module imports no native module: the whole native surface (better-sqlite3)
// lives in the child processes under out/.
//
// The 'electron' import resolves to an empty stub under vitest
// (vitest.config.ts) so main.test.ts can collect the two pure functions below
// (resolveOutDir, serviceDefsFromBootstrap) without the electron runtime — the
// module-scope boot side effects (requestSingleInstanceLock, whenReady) would
// crash a bare Node test runner. esbuild keeps the real electron external
// (build-main.mjs), so production is unaffected.
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
} from 'electron'
import { spawn as cpSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { platform } from 'node:os'
import { readBootstrap, type BootstrapData } from '../lib/bootstrap'
import { seedUserData } from '../lib/seed'
import { buildCliHome, installShim } from '../lib/shim'
import { Supervisor, type ServiceDef } from '../lib/supervisor'
import { openCrashWindow } from './crash-window'
import { logLine } from './log'
import { checkForUpdatesNow, initUpdater, setUpdaterWindow } from './updater'
import { createMainWindow } from './window'

const NODE_FLAT = platform() === 'win32' ? 'node.exe' : 'node'

// Where the three service bundles + bundled node runtime live. One function
// for both forms: in dev the module sits in dist/ (a sibling of out/);
// packaged, the bundles are in the asar and the EXEC-able parts
// (out/node/**, the .node addon) are auto-unpacked beside it under
// app.asar.unpacked/ — you cannot spawn out/node/node or load
// better_sqlite3.node from inside a packed asar (ENOTDIR / wrong-ABI).
//
// Two packaging traps, both hit in practice:
//  (1) Electron 44 does NOT set ELECTRON_IS_ASAR in this AppImage context —
//      a runtime probe showed it undefined even though the app was packed.
//      So the packaged branch keys on app.isPackaged (canonical), OR'd with
//      the env var so the unit test can drive it with a mock alone.
//  (2) app.getAppPath() still returns .../app.asar when packed, and
//      __dirname inside it points at the asar copy of main/ — resolving
//      out/ from there yields .../app.asar/out, which spawn rejects. The
//      packaged branch must address .../app.asar.unpacked/out instead.
//
// __dirname is defined in the CJS bundle; under vitest (ESM transform) it is
// undefined, so fall back to a computed path from process.cwd() — the tests
// always run with cwd=desktop/ (npm run test), making that identical to the
// production dist/ parent.
const LOCAL_DIRNAME: string =
  typeof __dirname !== 'undefined' ? __dirname : join(process.cwd(), 'main')

export function resolveOutDir(): string {
  // Packaged signal: Electron 44 does NOT set ELECTRON_IS_ASAR in this app's
  // AppImage context (verified by runtime probe — it was undefined), so the
  // env var alone is unreliable. app.isPackaged is the canonical flag and is
  // true for any electron-builder output. We OR it with the env var so the
  // unit test (which mocks only the env + resourcesPath, not app.isPackaged)
  // still drives the packaged branch.
  const packaged = process.env.ELECTRON_IS_ASAR === '1' || app.isPackaged
  if (packaged) {
    const rp = process.resourcesPath
    const base = rp !== undefined ? rp : dirname(LOCAL_DIRNAME)
    const unpacked = join(base, 'app.asar.unpacked', 'out')
    if (existsSync(unpacked)) return unpacked
    return join(base, 'app.asar', 'out')
  }
  return join(dirname(LOCAL_DIRNAME), 'out')
}

// The exact spawn recipes for the three services. The env is the complete
// environment: these children are self-contained node bundles that need no
// ambient PATH (nodeBin is absolute) or user-exported variables, so nothing
// leaks into them.
export function serviceDefsFromBootstrap(
  b: BootstrapData,
  outDir: string,
  nodeBin: string,
  userData: string
): ServiceDef[] {
  return [
    {
      id: 'kpp',
      command: nodeBin,
      args: [join(outDir, 'kpp.bundle.mjs'), 'serve'],
      env: { KPP_CONFIG: join(userData, 'kiro', 'config.json') },
      cwd: outDir,
    },
    {
      id: 'orcd',
      command: nodeBin,
      args: [join(outDir, 'orcd.bundle.mjs')],
      env: { ORC_CONFIG: join(userData, 'orcd.yaml') },
      cwd: userData,
    },
    {
      id: 'backend',
      command: nodeBin,
      args: [join(outDir, 'server.bundle.mjs')],
      env: {
        PORT: String(b.backendPort),
        HOST: '127.0.0.1',
        CLIENT_DIR: join(outDir, 'client'),
        ORC_NODES: join(userData, 'orc.yaml'),
        ORCHESTREL_DESKTOP: '1',
      },
      cwd: userData,
    },
  ]
}

function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

if (!app.requestSingleInstanceLock()) {
  // Second launch: the first instance's second-instance handler surfaces its
  // window; this one has nothing to do.
  app.quit()
  process.exit(0)
}

let supervisor: Supervisor | undefined
let mainWindow: ReturnType<typeof createMainWindow> | undefined
let quitting = false

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.win.isDestroyed() || mainWindow.closeRequested()) return
  const w = mainWindow.win
  if (w.isMinimized()) w.restore()
  w.focus()
})

async function boot(): Promise<void> {
  const userData = app.getPath('userData')
  const out = resolveOutDir()
  const nodeBin = join(out, 'node', NODE_FLAT)
  const seeded = await seedUserData(userData)
  await logLine('boot', `seeded=${seeded.seeded} backendPort=${seeded.backendPort}`)

  // The DB base tables (projects/cards) must exist before the backend's
  // initDatabase runs its ALTERs (synchronize:false). The bundled
  // better-sqlite3 is built for the shipped plain-node ABI, not Electron's,
  // so provisioning happens in a short-lived child of the bundled node —
  // the same runtime the backend child uses. Idempotent: CREATE IF NOT
  // EXISTS on a schema the migrations only ever widen.
  const { stdout: provOut, status: provStatus } = await new Promise<{
    stdout: string
    status: number | null
  }>((resolve) => {
    const c = cpSpawn(nodeBin, [join(out, 'provision-db.cjs'), join(userData, 'data', 'orchestrel.db')], {
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let so = ''
    c.stdout?.on('data', (d: Buffer) => (so += d.toString()))
    c.stderr?.on('data', (d: Buffer) => (so += d.toString()))
    c.on('close', (code) => resolve({ stdout: so, status: code }))
  })
  if (provStatus !== 0) {
    throw new Error(`DB provisioning failed (status ${provStatus}):\n${provOut}`)
  }

  const home = buildCliHome(userData, nodeBin, join(out, 'kpp.bundle.mjs'), app.getPath('home'))
  const { changed } = await installShim(home, {
    nodeBin,
    kppBundle: join(out, 'kpp.bundle.mjs'),
    // kpp.bundle.mjs declares better-sqlite3 external and resolves it (plus
    // the bindings/file-uri-to-path/process loader peers) from
    // cliHome/node_modules — without this copy, the closed-app CLI dies with
    // ERR_MODULE_NOT_FOUND.
    sqliteModulesRoot: join(out, 'node_modules'),
    binPath: home.binPath,
    homeDir: app.getPath('home'),
  })
  await logLine('boot', `shim changed=${changed} bin=${home.binPath}`)

  const healthUrl = `http://127.0.0.1:${seeded.backendPort}/`
  const pidFile = join(userData, 'service-pids.txt')
  const sup = new Supervisor({
    logDir: logDir(),
    healthUrl,
    pidFile,
    // The default spawn is childProcess.spawn; spelled out at the call site
    // because the supervisor keeps its own append-to-log piping around it.
    spawn: (c, a, o) => cpSpawn(c, a, { env: o.env, cwd: o.cwd, stdio: 'pipe' }),
  })
  supervisor = sup

  // Reap service children left orphaned by a previous instance that was
  // hard-killed (SIGTERM/SIGKILL never lets supervisor.stop() run). Must run
  // BEFORE we spawn our own, or we'd sweep nothing / sweep the wrong thing.
  const swept = sup.sweepOrphans()
  if (swept > 0) await logLine('boot', `swept ${swept} orphaned service pid(s) from a prior hard-killed instance`)

  sup.on('crash', (svc, tail, gaveUp) => {
    if (!gaveUp) return
    void logLine('crash', `${svc.id} gave up; opening crash window`)
    openCrashWindow(svc.id, tail, {
      onRestart: () => {
        // restart is the only sanctioned way back from given-up; it resets
        // that service's rate window and spawns once.
        void sup.restart(svc.id).then(() => void logLine('crash', `${svc.id} restarted`))
      },
      onQuit: () => app.quit(),
    })
  })

  await sup.start(serviceDefsFromBootstrap(seeded, out, nodeBin, userData))
  await logLine('boot', 'services healthy')

  mainWindow = createMainWindow(seeded.backendPort)
  setUpdaterWindow(mainWindow.win)
  // Updater starts after the window exists so the boot-time check has a
  // window to attach its modal dialog to. It is no-op-safe in dev.
  initUpdater()

  ipcMain.on('open-logs-folder', () => {
    void shell.openPath(logDir())
  })

  app.on('activate', () => {
    // macOS dock click: recreate only a window that never existed, not one
    // the user deliberately closed.
    if (
      !mainWindow ||
      mainWindow.win.isDestroyed() ||
      mainWindow.closeRequested()
    ) {
      const b = readBootstrap(userData)
      mainWindow = createMainWindow(b.backendPort)
    }
  })
}

function buildMenu(): void {
  const isMac = platform() === 'darwin'
  const help: Electron.MenuItemConstructorOptions[] = [
    { label: 'Open logs folder', click: () => void shell.openPath(logDir()) },
    {
      label: 'Check for updates now',
      click: () => checkForUpdatesNow(),
    },
    {
      label: 'About',
      click: () => {
        if (isMac) app.showAboutPanel()
        else
          dialog.showMessageBox({
            title: 'About Orchestrel',
            message: 'Orchestrel',
            detail: `Version ${app.getVersion()}`,
          })
      },
    },
  ]
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ label: app.name, submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'hide' as const }, { role: 'quit' as const }] }]
      : []),
    { label: 'Help', submenu: help },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  buildMenu()
  // before-quit must stop the children so nothing is orphaned; the handler
  // defers quit until stop() settles.
  app.on('before-quit', (e) => {
    if (quitting || !supervisor) return
    e.preventDefault()
    quitting = true
    void supervisor
      .stop()
      .then(() => void logLine('boot', 'stopped; quitting'))
      .finally(() => app.quit())
  })
  try {
    await boot()
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err)
    await logLine('boot', `FAILED: ${msg}`)
    dialog.showErrorBox('Orchestrel failed to start', msg)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  // The Board window IS the app: closing it quits, which runs before-quit →
  // supervisor.stop().
  if (platform() !== 'darwin') app.quit()
})

// Orphan protection is layered, because Electron does NOT run JS signal /
// exit handlers for SIGTERM/SIGKILL (it handles them at the native layer —
// verified empirically: no JS 'exit' fires when the main is killed).
//   1. Graceful quit (window close / menu quit) → before-quit → stop(). Works.
//   2. Hard kill (SIGTERM/SIGKILL to the app) → orphans the three node
//      services. Those children can't be reaped in-process, so the NEXT launch
//      reaps them: the supervisor records its child PIDs to a file, and
//      sweepOrphans() (called at the top of boot) SIGKILLs any PID from a
//      previous, un-cleanly-stopped instance that is still alive.
// Net effect: a kill -9 never leaves the backend port or a service hanging
// once the app is launched again (the normal recovery path).
