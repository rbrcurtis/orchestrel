import { WebSocketServer } from 'ws'
import type { Server as HttpServer } from 'http'
import type { Http2SecureServer } from 'http2'
import type { Plugin } from 'vite'
import { getRequestListener } from '@hono/node-server'
import { ConnectionManager } from './connections'
import { validateCfAccess } from './auth'

// NOTE: TypeORM entity imports must be lazy (dynamic import) because Vite bundles
// vite.config.ts with esbuild which uses TC39 decorators, not legacy TypeScript
// decorators that TypeORM requires. Static imports would fail at config bundle time.

// Cache httpServer across Vite server restarts (HMR re-runs configureServer)
let _cachedHttpServer: HttpServer | null = null
const _httpServerPromise = new Promise<HttpServer>((resolve) => {
  process.once('dispatcher:httpServer', (server: HttpServer) => {
    _cachedHttpServer = server
    resolve(server)
  })
})

function getHttpServer(): Promise<HttpServer> {
  if (_cachedHttpServer) return Promise.resolve(_cachedHttpServer)
  return _httpServerPromise
}

export const connections = new ConnectionManager()

export function createWsServer(
  httpServer: HttpServer | Http2SecureServer,
  handleMessage: (ws: import('ws').WebSocket, raw: unknown, connections: ConnectionManager) => void,
  clientSubs: { unsubscribeAll: (ws: import('ws').WebSocket) => void },
) {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', async (req, socket, head) => {
    if (req.url !== '/ws') return

    const valid = await validateCfAccess(req)
    if (!valid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    connections.add(ws)

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString())
        handleMessage(ws, data, connections)
      } catch (err) {
        console.error('WS message parse error:', err)
      }
    })

    ws.on('close', () => {
      clientSubs.unsubscribeAll(ws)
      connections.remove(ws)
    })
  })

  return wss
}

export function wsServerPlugin(): Plugin {
  return {
    name: 'dispatcher-ws',
    configureServer(server) {
      if (server.httpServer) {
        // All TypeORM-dependent imports are lazy to avoid decorator issues with Vite's esbuild
        Promise.all([
          import('../models/index'),
          import('./handlers'),
          import('./subscriptions'),
          import('../bus'),
          import('../opencode/server'),
          import('../api/rest'),
        ]).then(async ([{ initDatabase }, { handleMessage }, { clientSubs }, { messageBus }, { openCodeServer }, { createRestApi }]) => {
          await initDatabase()

          const { registerAutoStart, registerWorktreeCleanup } = await import('../controllers/oc')
          const { sessionService } = await import('../services/session')
          const { removeWorktree, worktreeExists } = await import('../worktree')
          registerAutoStart(undefined, sessionService)
          registerWorktreeCleanup(undefined, { removeWorktree, worktreeExists })
          console.log('[oc] controller listeners registered')

          createWsServer(server.httpServer!, handleMessage, clientSubs)
          console.log('[ws] WebSocket server attached to Vite dev server')

          // Publish OpenCode crash to bus — all connected clients get notified
          openCodeServer.onCrash = () => {
            messageBus.publish('system:error', {
              message: 'OpenCode server crashed, restarting...',
            })
          }

          openCodeServer.start().catch((err: unknown) => {
            console.error('[opencode] failed to start:', err)
          })

          // REST API middleware
          const restApp = createRestApi()
          const restHandler = getRequestListener(restApp.fetch)

          server.middlewares.use((req, res, next) => {
            if (req.url?.startsWith('/api/cards')) {
              restHandler(req, res)
            } else {
              next()
            }
          })
        }).catch((err) => {
          console.error('[db] failed to initialize:', err)
        })
      }
    },
  }
}
