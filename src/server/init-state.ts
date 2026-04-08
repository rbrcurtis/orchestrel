import type { WebSocketServer } from 'ws'
import type { Server as HttpServer } from 'http'
import type { Http2SecureServer } from 'http2'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'

/**
 * Server lifecycle state that must survive Vite dev server restarts.
 *
 * vite.config.ts is bundled by esbuild — module-level variables in files
 * statically imported by it reset on every re-bundle. But dynamic imports
 * go through Node.js module cache and persist. This module is always
 * dynamically imported, so its state survives.
 */

type AnyHttpServer = HttpServer | Http2SecureServer
type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

/** SessionManager — survives Vite restarts. */
import type { SessionManager } from './sessions/manager'
let _sessionManager: SessionManager | null = null
export function getSessionManager(): SessionManager | null { return _sessionManager }
export function setSessionManager(sm: SessionManager): void { _sessionManager = sm }

/** True after WSS, bus listeners, and SessionManager are initialized. */
export let initialized = false
export function markInitialized() { initialized = true }

/** Cached WebSocketServer — reused across Vite restarts. */
export let wss: WebSocketServer | null = null
export function setWss(instance: WebSocketServer) { wss = instance }

/** httpServer from server.js — arrives via process event, persists across restarts. */
let _httpServer: AnyHttpServer | null = null
const _httpServerReady = new Promise<AnyHttpServer>((resolve) => {
  if (_httpServer) { resolve(_httpServer); return }
  process.once('orchestrel:httpServer', (server: AnyHttpServer) => {
    _httpServer = server
    resolve(server)
  })
})

export function getHttpServer(): Promise<AnyHttpServer> {
  if (_httpServer) return Promise.resolve(_httpServer)
  return _httpServerReady
}

/** Track the current upgrade handler so we can replace it on restart. */
let _upgradeHandler: UpgradeHandler | null = null

export function attachUpgradeHandler(
  httpServer: AnyHttpServer,
  handler: UpgradeHandler,
) {
  // Remove previous handler if present (idempotent re-attach on restart)
  if (_upgradeHandler) {
    httpServer.removeListener('upgrade', _upgradeHandler)
  }
  _upgradeHandler = handler
  httpServer.on('upgrade', handler)
}
