/* oxlint-disable orchestrel/log-before-early-return -- init state plumbing, no session context */
import type { Server as HttpServer } from 'http'
import type { Http2SecureServer } from 'http2'
import type { AppServer } from './ws/types'
import type { OrcdClient } from './orcd-client'
import type { EventEmitter } from 'events'

type AnyHttpServer = HttpServer | Http2SecureServer

/**
 * State here must survive Vite dev-server restarts. Vite re-bundles vite.config.ts
 * with esbuild on every restart, and esbuild INLINES dynamic imports into the
 * single-file bundle — so module-level variables in this file get a fresh copy per
 * re-bundle and the Node module cache does NOT preserve them. globalThis is
 * process-global, so it survives.
 */
interface PersistedState {
  nodeClients: Map<string, OrcdClient>
  initialized: boolean
  io: AppServer | null
  httpServer: AnyHttpServer | null
  httpServerReady: Promise<AnyHttpServer> | null
  messageBus: EventEmitter | null
}

const g = globalThis as typeof globalThis & { __orchestrelInitState?: PersistedState }
const state = (g.__orchestrelInitState ??= {
  nodeClients: new Map(),
  initialized: false,
  io: null,
  httpServer: null,
  httpServerReady: null,
  messageBus: null,
})

/** Per-node OrcdClient registry — survives Vite restarts. */
export function setClientForNode(name: string, client: OrcdClient): void { state.nodeClients.set(name, client) }
export function getClientByNode(name: string): OrcdClient | null { return state.nodeClients.get(name) ?? null }
export function listNodeClients(): OrcdClient[] { return [...state.nodeClients.values()] }
export function clearNodeClients(): void { state.nodeClients.clear() }
/** Back-compat: callers that predate multi-node default to the 'local' node. */
export function getOrcdClient(): OrcdClient | null { return state.nodeClients.get('local') ?? null }

/** True after IO server, bus listeners, and OrcdClient are initialized. */
export function isInitialized(): boolean { return state.initialized }
export function markInitialized(): void { state.initialized = true }

/** Cached Socket.IO Server — reused across Vite restarts. */
export function getIo(): AppServer | null { return state.io }
export function setIo(instance: AppServer): void { state.io = instance }

/** Cached event bus — publishers and listeners must share it across Vite bundles. */
export function getMessageBus(): EventEmitter | null { return state.messageBus }
export function setMessageBus(bus: EventEmitter): void { state.messageBus = bus }

/** httpServer from server.js — arrives via process event, persists across restarts. */
export function getHttpServer(): Promise<AnyHttpServer> {
  if (state.httpServer) return Promise.resolve(state.httpServer)
  if (!state.httpServerReady) {
    state.httpServerReady = new Promise<AnyHttpServer>((resolve) => {
      process.once('orchestrel:httpServer', (server: AnyHttpServer) => {
        state.httpServer = server
        resolve(server)
      })
    })
  }
  return state.httpServerReady
}
