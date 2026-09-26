import type { Server as HttpServer } from 'http';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';
import { Server as IoServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../shared/ws-protocol';
import { startMemoryMaintainer } from '../lib/memory-maintainer/scheduler';

// Production-mode backend init, used by server.js when NODE_ENV !== 'development'.
// Mirrors the dev-mode init in ws/server.ts (wsServerPlugin) minus the Vite
// restart-survival machinery — production runs this exactly once per process.

export async function initBackend(): Promise<{
  restRouter: ExpressRouter;
  attachSocketIo: (httpServer: HttpServer) => void;
}> {
  const [{ initDatabase }, { registerSocketEvents }, { busRoomBridge }, { socketAuthMiddleware }, initState] =
    await Promise.all([
      import('./models/index'),
      import('./ws/handlers'),
      import('./ws/subscriptions'),
      import('./ws/auth'),
      import('./init-state'),
    ]);

  await initDatabase();

  // --- REST API ---
  const express = await import('express');
  const { RegisterRoutes } = await import('./api/generated/routes');

  const router = express.default.Router();
  router.use(express.default.json());
  RegisterRoutes(router);

  const { createAttachmentRouter } = await import('./attachments');
  router.use(createAttachmentRouter());

  // OpenAPI spec + Swagger UI
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const swaggerUi = await import('swagger-ui-express');

  const specPath = resolve(import.meta.dirname, './api/generated/swagger.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf-8'));

  router.get('/api/docs/swagger.json', (_req: Request, res: Response) => {
    res.json(spec);
  });
  router.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec));

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err && typeof err === 'object' && 'status' in err) {
      const e = err as { status: number; message?: string; fields?: Record<string, unknown> };
      console.warn(`[rest:error] status=${e.status} msg=${e.message ?? 'Validation error'}`);
      res.status(e.status).json({ error: e.message ?? 'Validation error', fields: e.fields });
      return;
    }
    next(err);
  });

  console.log('[rest] API routes registered');

  // --- Socket.IO creation deferred to attachSocketIo ---
  function attachSocketIo(httpServer: HttpServer) {
    const io = new IoServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
      httpServer,
      {
        serveClient: false,
        // See ws/server.ts: generous timeouts to survive Access-gated tunnel jitter.
        pingInterval: 25_000,
        pingTimeout: 30_000,
        cors: { origin: true, credentials: true },
      },
    );
    io.use(socketAuthMiddleware);
    io.on('connection', (socket) => registerSocketEvents(socket, io));
    busRoomBridge.init(io);
    initState.setIo(io);
    console.log('[ws] Socket.IO server attached');
  }

  // --- OrcdClient per node + controller listeners ---
  const { OrcdClient } = await import('./orcd-client');
  const { loadNodeRegistry } = await import('./config/nodes');
  const { initOrcdRouter, reconcileRunningCards, rearmScheduledSessions, registerAutoStart, registerWorktreeCleanup, registerProcessReaper } =
    await import('./controllers/card-sessions');

  const nodes = loadNodeRegistry();
  for (const node of nodes) {
    let client = initState.getClientByNode(node.name);
    if (!client) {
      client = new OrcdClient({ host: node.host, port: node.port, token: node.authToken, name: node.name });
      initState.setClientForNode(node.name, client);
      // Store the client BEFORE connecting. If a node's orcd isn't bound yet at
      // startup, connect() rejects; the client auto-reconnects, so once it's
      // stored + wired here, handlers resolve it and it works as soon as that
      // orcd comes up.
      try {
        await client.connect();
      } catch (err) {
        console.error(`[orcd] node ${node.name} initial connect failed (will retry):`, (err as Error).message);
      }
    }
    initOrcdRouter(client);
    try {
      await reconcileRunningCards(client);
      await rearmScheduledSessions(client);
    } catch (err) {
      console.error(`[startup] reconcile failed for ${node.name}:`, err);
    }
    const nodeClient = client;
    nodeClient.onReconnect(() => {
      console.log(`[orcd] node ${node.name} reconnected, reconciling...`);
      reconcileRunningCards(nodeClient).catch((e) => console.error(`[orcd] reconnect reconcile ${node.name}:`, e));
      rearmScheduledSessions(nodeClient).catch((e) => console.error(`[orcd] reconnect re-arm ${node.name}:`, e));
    });
  }

  registerAutoStart();
  registerWorktreeCleanup();
  registerProcessReaper();
  console.log(`[orcd] ${nodes.length} node client(s) initialized`);

  startMemoryMaintainer();

  initState.markInitialized();

  return { restRouter: router, attachSocketIo };
}
