import type { Plugin } from 'vite';
import { Server as IoServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../../shared/ws-protocol';

// NOTE: TypeORM entity imports must be lazy (dynamic import) because Vite bundles
// vite.config.ts with esbuild which uses TC39 decorators, not legacy TypeScript
// decorators that TypeORM requires. Static imports would fail at config bundle time.
//
// State that must survive Vite restarts lives in src/server/init-state.ts (dynamically
// imported, so Node.js module cache preserves it across re-bundles).

export function wsServerPlugin(): Plugin {
  return {
    name: 'orchestrel-ws',
    configureServer(server) {
      // Register REST middleware placeholder synchronously so it's in the middleware
      // stack BEFORE React Router's catch-all. The actual router activates after async init.
      let restApp: import('express').Express | null = null;
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
        import('./auth'),
        import('../init-state'),
      ])
        .then(
          async ([
            { initDatabase },
            { registerSocketEvents },
            { busRoomBridge },
            { socketAuthMiddleware },
            initState,
          ]) => {
            await initDatabase();

            // REST API routes are re-wired on each restart (restApp closure updates)
            const express = await import('express');
            const { RegisterRoutes } = await import('../api/generated/routes');

            const router = express.default();
            router.use(express.default.json());
            RegisterRoutes(router);

            // File upload route
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
                const dir = join('/tmp/orchestrel-uploads', sessionId);
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

            // --- Socket.IO: create once, persists across Vite restarts ---
            let io = initState.io;
            if (!io) {
              const httpServer = await initState.getHttpServer();
              io = new IoServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
                httpServer as import('http').Server,
                {
                  serveClient: false,
                  pingInterval: 10_000,
                  pingTimeout: 5_000,
                  cors: { origin: true, credentials: true },
                },
              );
              io.use(socketAuthMiddleware);
              io.on('connection', (socket) => registerSocketEvents(socket, io!));
              busRoomBridge.init(io);
              initState.setIo(io);
              console.log('[ws] Socket.IO server created');
            }

            // --- One-time init: SessionManager + controller listeners ---
            if (initState.initialized) return;

            const { SessionManager } = await import('../sessions/manager');
            const { registerAutoStart, registerWorktreeCleanup } = await import('../controllers/oc');

            let sm = initState.getSessionManager();
            if (!sm) {
              sm = new SessionManager();
              initState.setSessionManager(sm);
            }

            registerAutoStart();
            registerWorktreeCleanup();
            console.log('[sessions] SessionManager initialized, controller listeners registered');

            initState.markInitialized();

            // Move stale running cards to review
            try {
              const { Card } = await import('../models/Card');
              const cards = await Card.find({ where: { column: 'running' } });
              for (const card of cards) {
                if (card.queuePosition != null) continue;
                card.column = 'review';
                card.updatedAt = new Date().toISOString();
                await card.save();
                console.log(`[startup] card ${card.id} moved to review (no active session)`);
              }
            } catch (err) {
              console.error('[startup] stale card scan failed:', err);
            }
          },
        )
        .catch((err) => {
          console.error('[db] failed to initialize:', err);
        });
    },
  };
}
