import type { Server as HttpServer } from 'http';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';
import { Server as IoServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../shared/ws-protocol';

export async function initBackend(): Promise<{
  restRouter: ExpressRouter;
  attachSocketIo: (httpServer: HttpServer) => void;
}> {
  const [{ initDatabase }, { registerSocketEvents }, { busRoomBridge }, { socketAuthMiddleware }] =
    await Promise.all([
      import('./models/index'),
      import('./ws/handlers'),
      import('./ws/subscriptions'),
      import('./ws/auth'),
    ]);

  await initDatabase();

  // --- REST API ---
  const express = await import('express');
  const { RegisterRoutes } = await import('./api/generated/routes');

  const router = express.default.Router();
  router.use(express.default.json());
  RegisterRoutes(router);

  // File upload
  const multer = (await import('multer')).default;
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  const { randomUUID } = await import('crypto');

  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

  router.post('/api/upload', upload.array('files'), (req: Request, res: Response) => {
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
  });

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
        pingInterval: 10_000,
        pingTimeout: 5_000,
        cors: { origin: true, credentials: true },
      },
    );
    io.use(socketAuthMiddleware);
    io.on('connection', (socket) => registerSocketEvents(socket, io));
    busRoomBridge.init(io);
    console.log('[ws] Socket.IO server attached');
  }

  // --- OC controllers + OrcdClient ---
  const { OrcdClient } = await import('./orcd-client');
  const { loadNodeRegistry } = await import('./config/nodes');
  const { initOrcdRouter, reconcileRunningCards, registerAutoStart, registerWorktreeCleanup, registerMemoryUpsertOnArchive } =
    await import('./controllers/card-sessions');
  const initState = await import('./init-state');

  const nodes = loadNodeRegistry();
  for (const node of nodes) {
    let client = initState.getClientByNode(node.name);
    if (!client) {
      client = new OrcdClient({ host: node.host, port: node.port, token: node.authToken, name: node.name });
      initState.setClientForNode(node.name, client);
      try {
        await client.connect();
      } catch {
        console.warn(`[orcd] node ${node.name} initial connect failed, will retry in background`);
      }
    }
    initOrcdRouter(client);
    try {
      await reconcileRunningCards(client);
    } catch (err) {
      console.error(`[startup] reconcile failed for ${node.name}:`, err);
    }
    const nodeClient = client;
    nodeClient.onReconnect(() => {
      console.log(`[orcd] node ${node.name} reconnected, reconciling...`);
      reconcileRunningCards(nodeClient).catch((e) => console.error(`[orcd] reconnect reconcile ${node.name}:`, e));
    });
  }

  registerAutoStart();
  registerMemoryUpsertOnArchive();
  registerWorktreeCleanup();
  console.log(`[orcd] ${nodes.length} node client(s) initialized`);

  return { restRouter: router, attachSocketIo };
}
