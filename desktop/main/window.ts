// Main BoardWindow factory: sizes, webPreferences, and the navigate guard.
// The guard is the old wrapper's `internalHosts` pattern narrowed to the one
// internal origin this app talks to — `127.0.0.1:<backendPort>` on loopback.
// Everything else leaves the window via shell.openExternal (new-window
// attempts are denied outright).
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

// The port is only known after seeding, so the guard closes over it at window
// creation rather than reading it lazily.
export function createMainWindow(port: number): { win: BrowserWindow; closeRequested: () => boolean } {
  const internalHosts = new Set(['127.0.0.1', 'localhost'])
  const isInternal = (url: string): boolean => {
    try {
      const u = new URL(url)
      return internalHosts.has(u.hostname) && u.port === String(port)
    } catch {
      return false
    }
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    title: 'Orchestrel',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    // In-window opens to our own origin are allowed; everything else is an
    // external link the OS browser should own.
    if (!isInternal(url)) void shell.openExternal(url)
    return { action: isInternal(url) ? 'allow' : 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // Distinguishes a user close from an app-quit teardown: crash-window Quit
  // calls app.quit() so 'close' fires there too, and the single-instance
  // focus / activate logic must not resurrect a window the user closed.
  // Closure state, not a property — the electron type has no room for it.
  let closeRequested = false
  win.on('close', () => {
    closeRequested = true
  })

  // Single-tab local app: the page title is the app name, not whatever the
  // SPA last rendered.
  win.webContents.on('page-title-updated', (event) => event.preventDefault())

  void win.loadURL(`http://127.0.0.1:${port}`)
  win.once('ready-to-show', () => win.show())
  return { win, closeRequested: () => closeRequested }
}
