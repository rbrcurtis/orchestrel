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
                  console.warn(`[rest:upload] session=${sessionId}: no files in request, rejecting`);
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
                  console.warn(`[rest:error] status=${e.status} msg=${e.message ?? 'Validation error'}`);
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
                  destroyUpgrade: false, // let Vite HMR handle non-socket.io upgrades
                  // Generous timeouts: the FE connects through an Access-gated
                  // Cloudflare tunnel where short timeouts caused constant false
                  // disconnect/reconnect churn (every few seconds), which is what
                  // exposed the room-membership desync. Keep them well above tunnel
                  // jitter so a healthy connection stays put.
                  pingInterval: 25_000,
                  pingTimeout: 30_000,
                  cors: { origin: true, credentials: true },
                },
              );
              io.use(socketAuthMiddleware);
              io.on('connection', (socket) => registerSocketEvents(socket, io!));
              busRoomBridge.init(io);
              initState.setIo(io);
              console.log('[ws] Socket.IO server created');
            }

            // --- One-time init: OrcdClient + controller listeners ---
            if (initState.initialized) return;

            const [{ OrcdClient }, { loadConfig }, { homedir }] = await Promise.all([
              import('../orcd-client'),
              import('../../shared/config'),
              import('os'),
            ]);
            const { initOrcdRouter, reconcileRunningCards, rearmScheduledSessions, registerAutoStart, registerWorktreeCleanup, registerMemoryUpsertOnArchive, registerProcessReaper } =
              await import('../controllers/card-sessions');

            let client = initState.getOrcdClient();
            if (!client) {
              client = new OrcdClient(loadConfig().socket.replace(/^~/, homedir()));
              // Store the client BEFORE connecting. If orcd's socket isn't bound
              // yet at startup (systemd `After=orcd.service` orders start, not
              // socket-readiness — orcd takes ~15s to bind), connect() rejects.
              // The client auto-reconnects internally, so once it's stored + wired
              // here, handlers (agent:send etc.) resolve it and it works as soon as
              // orcd comes up. Previously a startup connect() rejection aborted this
              // whole init via the outer .catch, leaving getOrcdClient() null forever
              // (configureServer never re-runs), which bricked all prompt submission.
              initState.setOrcdClient(client);
            }

            // Register the single global orcd message router
            initOrcdRouter(client);

            client.onReconnect(() => {
              console.log('[orcd] orcd reconnected, reconciling running cards...');
              reconcileRunningCards(client!).catch((err) =>
                console.error('[orcd] reconnect reconciliation failed:', err),
              );
              rearmScheduledSessions(client!).catch((err) =>
                console.error('[orcd] reconnect scheduled-job re-arm failed:', err),
              );
            });

            // Best-effort initial connect + reconcile. A failure here (orcd not up
            // yet) must NOT abort init — the client's reconnect loop handles it, and
            // running-card reconcile re-runs via onReconnect once orcd is reachable.
            try {
              await client.connect();
              await reconcileRunningCards(client);
              await rearmScheduledSessions(client);
            } catch (err) {
              console.error('[startup] orcd not reachable at init; client will auto-reconnect:', err);
            }

            registerAutoStart();
            registerMemoryUpsertOnArchive();
            registerWorktreeCleanup();
            registerProcessReaper();
            console.log('[orcd] OrcdClient wired (router + listeners registered)');

            initState.markInitialized();
          },
        )
        .catch((err) => {
          console.error('[db] failed to initialize:', err);
        });
    },
  };
}
