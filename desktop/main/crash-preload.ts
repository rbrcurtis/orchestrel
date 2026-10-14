// Preload for the crash window only: exposes a single invoke() over the
// namespaced channel so the data: page (no nodeIntegration) can act.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ipc', {
  invoke: (channel: string, action: string): Promise<void> =>
    ipcRenderer.invoke(channel, action),
})
