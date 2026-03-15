import { WebSocketServer } from 'ws'
import type { Server as HttpServer } from 'http'
import type { Http2SecureServer } from 'http2'
import type { Plugin } from 'vite'
import { ConnectionManager } from './connections'
import { validateCfAccess } from './auth'

// NOTE: TypeORM entity imports must be lazy (dynamic import) because Vite bundles
// vite.config.ts with esbuild which uses TC39 decorators, not legacy TypeScript
// decorators that TypeORM requires. Static imports would fail at config bundle time.

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
      // Register REST middleware placeholder synchronously so it's in the middleware
      // stack BEFORE React Router's catch-all. The actual router activates after async init.
      let restApp: import('express').Router | null = null
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/') && restApp) {
          restApp(req as import('express').Request, res as import('express').Response, next)
        } else {
          next()
        }
      })

      // All TypeORM-dependent imports are lazy to avoid decorator issues with Vite's esbuild
      Promise.all([
        import('../models/index'),
        import('./handlers'),
        import('./subscriptions'),
        import('../bus'),
        import('../opencode/server'),
      ]).then(async ([{ initDatabase }, { handleMessage }, { clientSubs }, { messageBus }, { openCodeServer }]) => {
        await initDatabase()

        // WS server requires httpServer (only available when NOT in middlewareMode)
        if (server.httpServer) {
          createWsServer(server.httpServer, handleMessage, clientSubs)
          console.log('[ws] WebSocket server attached to Vite dev server')
        }

        // Publish OpenCode crash to bus — all connected clients get notified
        openCodeServer.onCrash = () => {
          messageBus.publish('system:error', {
            message: 'OpenCode server crashed, restarting...',
          })
        }

        openCodeServer.start().catch((err: unknown) => {
          console.error('[opencode] failed to start:', err)
        })

        // REST API middleware (tsoa-generated routes)
        const express = await import('express')
        const { RegisterRoutes } = await import('../api/generated/routes')

        const router = express.default.Router()
        router.use(express.default.json())
        RegisterRoutes(router)

        // Serve OpenAPI spec and Swagger UI
        const { readFileSync } = await import('fs')
        const { resolve } = await import('path')
        const swaggerUi = await import('swagger-ui-express')

        const specPath = resolve(import.meta.dirname, '../api/generated/swagger.json')
        const spec = JSON.parse(readFileSync(specPath, 'utf-8'))

        router.get('/api/docs/swagger.json', (_req: import('express').Request, res: import('express').Response) => {
          res.json(spec)
        })
        router.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec))

        // Error handler for tsoa validation errors
        router.use((err: unknown, _req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
          if (err && typeof err === 'object' && 'status' in err) {
            const e = err as { status: number; message?: string; fields?: Record<string, unknown> }
            res.status(e.status).json({ error: e.message ?? 'Validation error', fields: e.fields })
            return
          }
          next(err)
        })

        // Activate the sync placeholder registered above
        restApp = router
        console.log('[rest] REST API mounted at /api/')
      }).catch((err) => {
        console.error('[db] failed to initialize:', err)
      })
    },
  }
}
