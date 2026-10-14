// Test-only runtime stand-in for the `electron` module. main.test.ts imports
// the pure functions out of main.ts, which drags the electron import along; a
// bare Vitest process has no electron runtime, and the module-scope boot code
// (requestSingleInstanceLock, whenReady) would crash collection. vitest's
// resolve.alias points 'electron' here ONLY for tests (see vitest.config.ts);
// esbuild keeps the real electron external (build-main.mjs), so production is
// unaffected. Nothing in the pure slice touches these values, and the boot
// code never runs because whenReady() never settles under vitest.
//
// The values below are structurally incomplete on purpose: only
// requestSingleInstanceLock and whenReady execute at module scope, and the
// rest exist so main.ts typechecks and collects without the real electron API.
export const app: {
  requestSingleInstanceLock(): boolean
  on(_event: string, _listener: (...args: unknown[]) => void): void
  whenReady(): Promise<void>
  quit(): void
  getPath(_name: string): string
  showAboutPanel(): void
  isPackaged: boolean
  relaunch(): void
  name: string
  getVersion(): string
} = {
  // true: tests import this module for the pure functions and must not hit
  // the second-instance exit path at module scope.
  requestSingleInstanceLock: () => true,
  on: () => {},
  whenReady: () => new Promise(() => {}),
  quit: () => {},
  getPath: () => '/nonexistent',
  showAboutPanel: () => {},
  isPackaged: false,
  relaunch: () => {},
  name: 'Orchestrel',
  getVersion: () => '0.0.0',
}
export const BrowserWindow: {
  getAllWindows(): unknown[]
  getFocusedWindow(): unknown
} = {
  getAllWindows: () => [],
  getFocusedWindow: () => undefined,
}
export const Menu: {
  setApplicationMenu(_menu: unknown): void
  buildFromTemplate(_template: unknown[]): unknown
} = {
  setApplicationMenu: () => {},
  buildFromTemplate: () => undefined,
}
export const dialog: {
  showErrorBox(_title: string, _content: string): void
  showMessageBox(_win: unknown, _opts: Record<string, string>): Promise<unknown>
  showMessageBoxSync(_opts: Record<string, string>): number
} = {
  showErrorBox: () => {},
  showMessageBox: () => Promise.resolve(undefined),
  showMessageBoxSync: () => 0,
}
export const ipcMain: {
  on(_channel: string, _listener: (event: unknown, ...args: unknown[]) => void): void
  handle(_channel: string, _listener: (event: unknown, ...args: unknown[]) => Promise<unknown>): void
  removeHandler(_channel: string): void
} = {
  on: () => {},
  handle: () => {},
  removeHandler: () => {},
}
export const shell: {
  openPath(_p: string): Promise<string>
  openExternal(_url: string): Promise<string>
} = {
  openPath: () => Promise.resolve(''),
  openExternal: () => Promise.resolve(''),
}
