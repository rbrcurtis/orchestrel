import type { Server as HttpServer } from 'http'
import type { Http2SecureServer } from 'http2'
import type { AppServer } from './ws/types'

type AnyHttpServer = HttpServer | Http2SecureServer

/** OrcdClient — survives Vite restarts. */
import type { OrcdClient } from './orcd-client'
let _orcdClient: OrcdClient | null = null
export function getOrcdClient(): OrcdClient | null { return _orcdClient }
export function setOrcdClient(client: OrcdClient): void { _orcdClient = client }

/** True after IO server, bus listeners, and OrcdClient are initialized. */
export let initialized = false
export function markInitialized() { initialized = true }

/** Cached Socket.IO Server — reused across Vite restarts. */
export let io: AppServer | null = null
export function setIo(instance: AppServer) { io = instance }

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
