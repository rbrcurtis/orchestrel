// contextBridge whitelist for the renderer. Only three capabilities cross
// the bridge — the Board app is a normal SPA and needs nothing else.
// openExternal accepts only http/https (no file://, no custom schemes) so
// a compromised renderer cannot exfiltrate local files through the shell.
import { contextBridge, ipcRenderer, shell } from 'electron'

contextBridge.exposeInMainWorld('orchestrel', {
  // Fired by main when a pending update has been downloaded (Task 7 wires
  // the sender); the cb receives a displayable update summary.
  onUpdateReady: (cb: (info: string) => void): void => {
    ipcRenderer.on('update-ready', (_event, info) => cb(String(info)))
  },
  openExternal: (url: string): void => {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(url)
  },
  openLogsFolder: (): void => {
    ipcRenderer.send('open-logs-folder')
  },
})
