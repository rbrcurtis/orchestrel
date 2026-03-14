import { WebSocketServer } from 'ws'
import type { Server as HttpServer } from 'http'
import type { Http2SecureServer } from 'http2'
import type { Plugin } from 'vite'
import { getRequestListener } from '@hono/node-server'
import { ConnectionManager } from './connections'
import { clientSubs } from './subscriptions'
import { messageBus } from '../bus'
import { initDatabase } from '../models/index'
import { validateCfAccess } from './auth'
import { handleMessage } from './handlers'
import { createRestApi } from '../api/rest'
import { openCodeServer } from '../opencode/server'

export const connections = new ConnectionManager()

export function createWsServer(httpServer: HttpServer | Http2SecureServer) {
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
        // Initialize TypeORM DataSource before accepting connections
        initDatabase().then(() => {
          createWsServer(server.httpServer!)
          console.log('[ws] WebSocket server attached to Vite dev server')
        }).catch((err) => {
          console.error('[db] failed to initialize database:', err)
        })

        // Publish OpenCode crash to bus — all connected clients get notified
        openCodeServer.onCrash = () => {
          messageBus.publish('system:error', {
            message: 'OpenCode server crashed, restarting...',
          })
        }

        openCodeServer.start().catch((err) => {
          console.error('[opencode] failed to start:', err)
        })
      }

      const restApp = createRestApi()
      const restHandler = getRequestListener(restApp.fetch)

      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/cards')) {
          restHandler(req, res)
        } else {
          next()
        }
      })
    },
  }
}
