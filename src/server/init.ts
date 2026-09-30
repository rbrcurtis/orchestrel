import type { Server as HttpServer } from 'http';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';
import { Server as IoServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../shared/ws-protocol';
import { startMemoryMaintainer } from '../lib/memory-maintainer/scheduler';
import { startPreferenceMaintainer } from '../lib/preference-maintainer/scheduler';
import { startupMark } from './startup-timing';

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

  startupMark('core modules loaded');

  await initDatabase();
  startupMark('database ready');

  // --- REST API ---
  const express = await import('express');
  const { RegisterRoutes } = await import('./api/generated/routes');
  startupMark('route table loaded');

  const router = express.default.Router();
  router.use(express.default.json());
  RegisterRoutes(router);

  const { createAttachmentRouter } = await import('./attachments');
  router.use(createAttachmentRouter());

  // OpenAPI spec + Swagger UI are mounted lazily: nothing but those docs routes uses
  // either, so neither is loaded on the boot path.
  const { resolve } = await import('path');
  const { mountDocs } = await import('./api/docs-router');
  mountDocs(router, resolve(import.meta.dirname, './api/generated/swagger.json'));

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
  startupMark('REST routes registered');

  // --- Socket.IO creation deferred to attachSocketIo ---
  function attachSocketIo(httpServer: HttpServer) {
    const io = new IoServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
      serveClient: false,
      // See ws/server.ts: generous timeouts to survive Access-gated tunnel jitter.
      pingInterval: 25_000,
      pingTimeout: 30_000,
      cors: { origin: true, credentials: true },
    });
    io.use(socketAuthMiddleware);
    io.on('connection', (socket) => registerSocketEvents(socket, io));
    busRoomBridge.init(io);
    initState.setIo(io);
    console.log('[ws] Socket.IO server attached');
  }

  // --- OrcdClient per node + controller listeners ---
  const { OrcdClient } = await import('./orcd-client');
  const { loadNodeRegistry } = await import('./config/nodes');
  const {
    createSyncContext,
    initOrcdRouter,
    registerAutoStart,
    registerProcessReaper,
    registerWorktreeCleanup,
    syncNode,
  } = await import('./controllers/card-sessions');

  const nodes = loadNodeRegistry();
  startupMark(`node registry loaded (${nodes.length} nodes)`);

  // Register the board/session listeners BEFORE the node loop. The loop waits on each
  // node's connect + sync, so an unreachable node (oni over Tailscale) used to hold it
  // for minutes and a card that entered running in that window was silently ignored —
  // it hung in running with no session.
  registerAutoStart();
  registerWorktreeCleanup();
  registerProcessReaper();

  // Projects and worktrees are shared by all three nodes, so load them once for the
  // whole pass instead of once per node.
  const syncCtx = await createSyncContext();
  startupMark('sync context ready');

  // The nodes are independent, so connect and sync them together rather than in series.
  await Promise.all(
    nodes.map(async (node) => {
      let client = initState.getClientByNode(node.name);
      const fresh = !client;
      if (!client) {
        client = new OrcdClient({ host: node.host, port: node.port, token: node.authToken, name: node.name });
        // Store the client BEFORE connecting. If a node's orcd isn't bound yet at
        // startup, connect() rejects; the client auto-reconnects, so once it's
        // stored + wired here, handlers resolve it and it works as soon as that
        // orcd comes up.
        initState.setClientForNode(node.name, client);
      }
      const nodeClient = client;
      // Wire the router before connecting so messages that arrive during the
      // handshake are still routed.
      initOrcdRouter(nodeClient);
      if (fresh) {
        try {
          await nodeClient.connect();
        } catch (err) {
          console.error(`[orcd] node ${node.name} initial connect failed (will retry):`, (err as Error).message);
        }
      }
      startupMark(`node ${node.name} connected`);
      try {
        await syncNode(nodeClient, syncCtx);
      } catch (err) {
        console.error(`[startup] sync failed for ${node.name}:`, err);
      }
      startupMark(`node ${node.name} synced`);
      nodeClient.onReconnect(() => {
        console.log(`[orcd] node ${node.name} reconnected, syncing...`);
        syncNode(nodeClient, syncCtx).catch((e) => console.error(`[orcd] reconnect sync ${node.name}:`, e));
      });
    }),
  );

  console.log(`[orcd] ${nodes.length} node client(s) initialized`);
  startupMark('all nodes synced');

  startMemoryMaintainer();
  startPreferenceMaintainer();

  const { startSleepScheduleCleanup } = await import('./services/sleep');
  startSleepScheduleCleanup();

  initState.markInitialized();
  startupMark('backend init complete');

  return { restRouter: router, attachSocketIo };
}
