import type { Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import type { IncomingMessage } from 'http';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';

/**
 * Initialise the full backend stack: DB, REST API, WebSocket server, and OpenCode.
 *
 * In dev mode this is called from the Vite plugin (`wsServerPlugin`).
 * In production it's called directly from server.js.
 *
 * Returns the Express router for REST API routes and a function to attach
 * the WS upgrade handler to an HTTP server.
 */
export async function initBackend(): Promise<{
  restRouter: ExpressRouter;
  attachWs: (httpServer: HttpServer) => void;
}> {
  const [{ initDatabase }, { handleMessage }, { clientSubs }, { openCodeServer }, { validateCfAccess }] =
    await Promise.all([
      import('./models/index'),
      import('./ws/handlers'),
      import('./ws/subscriptions'),
      import('./opencode/server'),
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

  // tsoa validation error handler
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err && typeof err === 'object' && 'status' in err) {
      const e = err as { status: number; message?: string; fields?: Record<string, unknown> };
      res.status(e.status).json({ error: e.message ?? 'Validation error', fields: e.fields });
      return;
    }
    next(err);
  });

  console.log('[rest] API routes registered');

  // --- WebSocket ---
  const { WebSocketServer } = await import('ws');
  const { ConnectionManager } = await import('./ws/connections');

  const connections = new ConnectionManager();
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

  function attachWs(httpServer: HttpServer) {
    httpServer.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (req.url !== '/ws') return;

      const valid = await validateCfAccess(req);
      if (!valid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
    console.log('[ws] WebSocket server attached');
  }

  // --- OC controllers + OpenCode server ---
  const { registerAutoStart, registerWorktreeCleanup } = await import('./controllers/oc');
  const { sessionService } = await import('./services/session');
  const { removeWorktree, worktreeExists } = await import('./worktree');
  registerAutoStart(undefined, sessionService);
  registerWorktreeCleanup(undefined, { removeWorktree, worktreeExists });
  console.log('[oc] controller listeners registered');

  openCodeServer
    .start()
    .then(async () => {
      try {
        const { Card } = await import('./models/Card');
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
    })
    .catch((err: unknown) => {
      console.error('[opencode] failed to start:', err);
    });

  return { restRouter: router, attachWs };
}
