import { WebSocketServer } from 'ws';
import type { Plugin } from 'vite';
import { ConnectionManager } from './connections';
import { validateCfAccess } from './auth';

// NOTE: TypeORM entity imports must be lazy (dynamic import) because Vite bundles
// vite.config.ts with esbuild which uses TC39 decorators, not legacy TypeScript
// decorators that TypeORM requires. Static imports would fail at config bundle time.
//
// State that must survive Vite restarts lives in src/server/init-state.ts (dynamically
// imported, so Node.js module cache preserves it across re-bundles).

export const connections = new ConnectionManager();

function createWsServer(
  handleMessage: (ws: import('ws').WebSocket, raw: unknown, connections: ConnectionManager) => void,
  clientSubs: { unsubscribeAll: (ws: import('ws').WebSocket) => void },
) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    connections.add(ws);

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        handleMessage(ws, data, connections);
      } catch (err) {
        console.error('WS message parse error:', err);
      }
    });

    ws.on('close', () => {
      clientSubs.unsubscribeAll(ws);
      connections.remove(ws);
    });
  });

  return wss;
}

export function wsServerPlugin(): Plugin {
  return {
    name: 'dispatcher-ws',
    configureServer(server) {
      // Register REST middleware placeholder synchronously so it's in the middleware
      // stack BEFORE React Router's catch-all. The actual router activates after async init.
      let restApp: import('express').Router | null = null;
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/') && restApp) {
          restApp(req as import('express').Request, res as import('express').Response, next);
        } else {
          next();
        }
      });

      // All TypeORM-dependent imports are lazy to avoid decorator issues with Vite's esbuild
      Promise.all([
        import('../models/index'),
        import('./handlers'),
        import('./subscriptions'),
        import('../bus'),
        import('../opencode/server'),
        import('../init-state'),
      ])
        .then(
          async ([
            { initDatabase },
            { handleMessage },
            { clientSubs },
            { messageBus },
            { openCodeServer },
            initState,
          ]) => {
            await initDatabase();

            // REST API routes are re-wired on each restart (restApp closure updates)
            const express = await import('express');
            const { RegisterRoutes } = await import('../api/generated/routes');

            const router = express.default.Router();
            router.use(express.default.json());
            RegisterRoutes(router);

            // File upload route — multer handles multipart/form-data parsing.
            // Note: app runs in React Router SPA mode so route actions never execute server-side;
            // uploads must live here in the Express router alongside the other API routes.
            const multer = (await import('multer')).default;
            const { writeFileSync, mkdirSync } = await import('fs');
            const { join } = await import('path');
            const { randomUUID } = await import('crypto');

            const MAX_FILE_SIZE = 25 * 1024 * 1024;
            const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

            router.post(
              '/api/upload',
              upload.array('files'),
              (req: import('express').Request, res: import('express').Response) => {
                const rawSessionId = (req.body?.sessionId as string | undefined) ?? 'unsorted';
                const sessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
                const dir = join('/tmp/dispatcher-uploads', sessionId);
                mkdirSync(dir, { recursive: true });

                const files = req.files as Express.Multer.File[] | undefined;
                if (!files?.length) {
                  res.status(400).json({ error: 'No files uploaded' });
                  return;
                }

                const refs = files.map((f) => {
                  const id = randomUUID().slice(0, 8);
                  const filename = `${id}-${f.originalname}`;
                  const filePath = join(dir, filename);
                  writeFileSync(filePath, f.buffer);
                  return { id, name: f.originalname, mimeType: f.mimetype, path: filePath, size: f.size };
                });

                res.json({ files: refs });
              },
            );

            // Serve OpenAPI spec and Swagger UI
            const { readFileSync } = await import('fs');
            const { resolve } = await import('path');
            const swaggerUi = await import('swagger-ui-express');

            const specPath = resolve(import.meta.dirname, '../api/generated/swagger.json');
            const spec = JSON.parse(readFileSync(specPath, 'utf-8'));

            router.get('/api/docs/swagger.json', (_req: import('express').Request, res: import('express').Response) => {
              res.json(spec);
            });
            router.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec));

            // Error handler for tsoa validation errors
            router.use(
              (
                err: unknown,
                _req: import('express').Request,
                res: import('express').Response,
                next: import('express').NextFunction,
              ) => {
                if (err && typeof err === 'object' && 'status' in err) {
                  const e = err as { status: number; message?: string; fields?: Record<string, unknown> };
                  res.status(e.status).json({ error: e.message ?? 'Validation error', fields: e.fields });
                  return;
                }
                next(err);
              },
            );

            restApp = router;
            console.log('[rest] API routes registered');

            // --- WSS: create once, re-attach upgrade handler on each restart ---
            let wss = initState.wss;
            if (!wss) {
              wss = createWsServer(handleMessage, clientSubs);
              initState.setWss(wss);
            }

            const httpServer = await initState.getHttpServer();
            initState.attachUpgradeHandler(
              httpServer,
              async (req: import('http').IncomingMessage, socket: import('stream').Duplex, head: Buffer) => {
                if (req.url !== '/ws') return;

                const valid = await validateCfAccess(req);
                if (!valid) {
                  socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                  socket.destroy();
                  return;
                }

                wss!.handleUpgrade(req, socket, head, (ws) => {
                  wss!.emit('connection', ws, req);
                });
              },
            );
            console.log('[ws] WebSocket server attached');

            // --- One-time init: OC listeners, OpenCode server ---
            if (initState.initialized) return;
            initState.markInitialized();

            const { registerAutoStart, registerWorktreeCleanup } = await import('../controllers/oc');
            const { sessionService } = await import('../services/session');
            const { removeWorktree, worktreeExists } = await import('../worktree');
            registerAutoStart(undefined, sessionService);
            registerWorktreeCleanup(undefined, { removeWorktree, worktreeExists });
            console.log('[oc] controller listeners registered');

            openCodeServer.start().then(async () => {
              // Re-attach to any running sessions that survived a dispatcher restart
              try {
                const { Card } = await import('../models/Card');
                const cards = await Card.find({ where: { column: 'running' } });
                for (const card of cards) {
                  if (!card.sessionId) continue;
                  try {
                    const attached = await sessionService.attachSession(card.id);
                    if (attached) {
                      console.log(`[startup] re-attached to session for card ${card.id}`);
                    } else {
                      card.column = 'review';
                      card.updatedAt = new Date().toISOString();
                      await card.save();
                      console.log(`[startup] session dead for card ${card.id}, moved to review`);
                    }
                  } catch (err) {
                    console.error(`[startup] re-attach failed for card ${card.id}:`, err);
                  }
                }
              } catch (err) {
                console.error('[startup] re-attach scan failed:', err);
              }
            }).catch((err: unknown) => {
              console.error('[opencode] failed to start:', err);
            });
          },
        )
        .catch((err) => {
          console.error('[db] failed to initialize:', err);
        });
    },
  };
}
