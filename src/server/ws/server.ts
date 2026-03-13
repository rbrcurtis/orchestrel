import { WebSocketServer } from 'ws'
import type { Server as HttpServer } from 'http'
import type { Http2SecureServer } from 'http2'
import type { Plugin } from 'vite'
import { getRequestListener } from '@hono/node-server'
import { ConnectionManager } from './connections'
import { DbMutator } from '../db/mutator'
import { validateCfAccess } from './auth'
import { handleMessage } from './handlers'
import { unsubscribeAllSessions } from '../agents/begin-session'
import { createRestApi } from '../api/rest'
import { openCodeServer } from '../opencode/server'

export const connections = new ConnectionManager()
export const mutator = new DbMutator(connections)

export function createWsServer(httpServer: HttpServer | Http2SecureServer) {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', async (req, socket, head) => {
    // Only handle /ws path
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
        handleMessage(ws, data, connections, mutator)
      } catch (err) {
        console.error('WS message parse error:', err)
      }
    })

    ws.on('close', () => {
      unsubscribeAllSessions(ws)
      connections.remove(ws)
    })
  })

  return wss
}

/**
 * Vite plugin to attach WS server to dev server's HTTP server.
 */
export function wsServerPlugin(): Plugin {
  return {
    name: 'dispatcher-ws',
    configureServer(server) {
      if (server.httpServer) {
        createWsServer(server.httpServer)
        console.log('[ws] WebSocket server attached to Vite dev server')

        // Start OpenCode server
        openCodeServer.onCrash = () => {
          connections.broadcast({
            type: 'agent:message',
            cardId: -1,
            data: { type: 'error', role: 'system', content: 'OpenCode server crashed, restarting...', timestamp: Date.now() },
          })
        }

        openCodeServer.start().catch((err) => {
          console.error('[opencode] failed to start:', err)
        })
      }

      const restApp = createRestApi(mutator)
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
