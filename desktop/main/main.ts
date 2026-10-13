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
// (outDirFor, serviceDefsFromBootstrap) without the electron runtime — the
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
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { platform } from 'node:os'
import { readBootstrap, type BootstrapData } from '../lib/bootstrap'
import { seedUserData } from '../lib/seed'
import { buildCliHome, installShim } from '../lib/shim'
import { Supervisor, type ServiceDef } from '../lib/supervisor'
import { openCrashWindow } from './crash-window'
import { createMainWindow } from './window'

const NODE_FLAT = platform() === 'win32' ? 'node.exe' : 'node'

// Where the three service bundles + bundled node runtime live. One function
// on purpose: Task 8 swaps the packaged branch for asar-unpacked resolution
// in this single spot. The bundle sits in dist/ (a sibling of out/).
// __dirname is defined in the CJS bundle; under vitest (ESM transform) it is
// undefined, so fall back to a computed path from process.cwd() — the tests
// always run with cwd=desktop/ (npm run test), making that identical to the
// production dist/ parent.
const LOCAL_DIRNAME: string =
  typeof __dirname !== 'undefined' ? __dirname : join(process.cwd(), 'main')

export function outDirFor(): string {
  if (process.env.ELECTRON_IS_ASAR === '1')
    return join(process.resourcesPath, 'app.asar.unpacked', 'out')
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
      },
      cwd: userData,
    },
  ]
}

function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

async function logLine(svc: string, ...parts: unknown[]): Promise<void> {
  try {
    await appendFile(join(logDir(), 'main.log'), `${new Date().toISOString()} [${svc}] ${parts.join(' ')}\n`)
  } catch {
    // logging must never take the app down
  }
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
  const out = outDirFor()
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
  const sup = new Supervisor({
    logDir: logDir(),
    healthUrl,
    // The default spawn is childProcess.spawn; spelled out at the call site
    // because the supervisor keeps its own append-to-log piping around it.
    spawn: (c, a, o) => cpSpawn(c, a, { env: o.env, cwd: o.cwd, stdio: 'pipe' }),
  })
  supervisor = sup

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
      // Task 7 wires the real updater; the menu shape is fixed now, the
      // action is a logged no-op until then.
      label: 'Check for updates now',
      click: () => void logLine('updates', 'check for updates now (placeholder, Task 7)'),
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
