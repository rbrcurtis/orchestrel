// The crash window: shown when a supervised service exceeds the respawn rate
// window and the supervisor gives up. A standalone 520x360 BrowserWindow
// (not modal — modality would freeze the main window while the user reads
// logs) loads an inline data: HTML page, so the app ships no asset files for
// it. The log tail is HTML-escaped before it is embedded in the data URL, so
// nothing from a child process is interpreted as markup. Buttons act via a
// single namespaced invoke channel: Restart triggers the caller-provided
// supervisor restart (then closes), Copy puts the tail text on the clipboard,
// Quit calls app.quit (handled by the main-process handler, not the page).
import { BrowserWindow, clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'

const CHANNEL = 'orchestrel-crash'

export interface CrashHandlers {
  onRestart: () => void
  onQuit: () => void
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function crashPage(id: string, tail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(id)} crashed</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 12px; background: #1c1c1e; color: #e5e5ea; font-size: 13px; }
  h1 { font-size: 15px; margin: 0 0 8px; }
  pre { background: #000; color: #b5b5b5; padding: 8px; border-radius: 4px; height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .row { margin-top: 10px; display: flex; gap: 8px; }
  button { padding: 5px 10px; border: 0; border-radius: 4px; background: #3a3a3c; color: #fff; cursor: pointer; }
</style></head><body>
<h1>Service "${escapeHtml(id)}" crashed</h1>
<p>Too many rapid exits — the supervisor stopped respawning it.</p>
<pre>${escapeHtml(tail)}</pre>
<div class="row">
  <button onclick="ipc.invoke('${CHANNEL}','restart')">Restart services</button>
  <button onclick="ipc.invoke('${CHANNEL}','copy')">Copy logs</button>
  <button onclick="ipc.invoke('${CHANNEL}','quit')">Quit</button>
</div></body></html>`
}

export function openCrashWindow(id: string, tail: string, h: CrashHandlers): BrowserWindow {
  // removeHandler before handle: two services can give up while a crash
  // window is still open; re-registering the same channel without removal
  // throws ERR_IPC_MAIN_ALREADY_HANDLE and crashes the main process. Handler
  // is removed on close too, so windows can never stack handlers.
  ipcMain.removeHandler(CHANNEL)
  ipcMain.handle(CHANNEL, async (_e: IpcMainInvokeEvent, action: string) => {
    switch (action) {
      case 'restart':
        h.onRestart()
        break
      case 'copy':
        clipboard.writeText(tail)
        break
      case 'quit':
        h.onQuit()
        break
    }
  })
  const win = new BrowserWindow({
    width: 520,
    height: 360,
    resizable: true,
    title: `Orchestrel — ${id} crashed`,
    webPreferences: {
      preload: join(__dirname, 'crash-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setMenuBarVisibility(false)
  // Closing the window without choosing an action leaves the service down —
  // surface that so it is not discovered as silence later.
  win.on('closed', () => {
    ipcMain.removeHandler(CHANNEL)
  })
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(crashPage(id, tail)))
  return win
}
