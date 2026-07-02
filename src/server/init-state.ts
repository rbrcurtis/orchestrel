/* oxlint-disable orchestrel/log-before-early-return -- init state plumbing, no session context */
import type { Server as HttpServer } from 'http'
import type { Http2SecureServer } from 'http2'
import type { AppServer } from './ws/types'

type AnyHttpServer = HttpServer | Http2SecureServer

/** Per-node OrcdClient registry — survives Vite restarts. */
import type { OrcdClient } from './orcd-client'
const _nodeClients = new Map<string, OrcdClient>()
export function setClientForNode(name: string, client: OrcdClient): void { _nodeClients.set(name, client) }
export function getClientByNode(name: string): OrcdClient | null { return _nodeClients.get(name) ?? null }
export function listNodeClients(): OrcdClient[] { return [..._nodeClients.values()] }
export function clearNodeClients(): void { _nodeClients.clear() }
/** Back-compat: callers that predate multi-node default to the 'local' node. */
export function getOrcdClient(): OrcdClient | null { return _nodeClients.get('local') ?? null }

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
