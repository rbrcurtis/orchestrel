// contextBridge whitelist for the renderer. Only two capabilities cross
// the bridge — the Board app is a normal SPA and needs nothing else.
// openExternal accepts only http/https (no file://, no custom schemes) so
// a compromised renderer cannot exfiltrate local files through the shell.
import { contextBridge, ipcRenderer, shell } from 'electron'

contextBridge.exposeInMainWorld('orchestrel', {
  openExternal: (url: string): void => {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(url)
  },
  openLogsFolder: (): void => {
    ipcRenderer.send('open-logs-folder')
  },
})
