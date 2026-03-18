import compression from 'compression';
import express from 'express';
import morgan from 'morgan';

const DEVELOPMENT = process.env.NODE_ENV === 'development';
const PORT = Number.parseInt(process.env.PORT || (DEVELOPMENT ? '6195' : '6194'));

const app = express();

app.use(
  compression({
    filter: (req, res) => {
      if (req.headers.accept === 'text/event-stream') return false;
      return compression.filter(req, res);
    },
  }),
);
app.disable('x-powered-by');

/** @type {((server: import('http').Server) => void) | null} */
let pendingAttachWs = null;

if (DEVELOPMENT) {
  console.log('Starting development server');
  const viteDevServer = await import('vite').then((vite) =>
    vite.createServer({
      server: { middlewareMode: true },
    }),
  );
  app.use(viteDevServer.middlewares);
  app.use(async (req, res, next) => {
    try {
      const source = await viteDevServer.ssrLoadModule('./server/app.ts');
      return await source.app(req, res, next);
    } catch (error) {
      if (typeof error === 'object' && error instanceof Error) {
        viteDevServer.ssrFixStacktrace(error);
      }
      next(error);
    }
  });
} else {
  console.log('Starting production server');
  app.use(morgan('tiny'));

  // Initialise the backend (DB, REST API, WS, OpenCode) — this is handled by the
  // Vite plugin in dev, but in production we call it directly.
  // @ts-expect-error .ts extension needed at runtime for tsx loader
  const { initBackend } = await import('./src/server/init.ts');
  const { restRouter, attachWs } = await initBackend();

  // REST API routes
  app.use(restRouter);

  // SPA static assets
  app.use('/assets', express.static('build/client/assets', { immutable: true, maxAge: '1y' }));
  app.use(express.static('build/client', { maxAge: '1h' }));

  // SPA fallback — serve index.html for all non-API, non-asset routes
  app.get('/{*path}', (_req, res) => {
    res.sendFile('index.html', { root: 'build/client' });
  });

  pendingAttachWs = attachWs;
}

const HOST = process.env.HOST || '0.0.0.0';
const httpServer = app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});

if (DEVELOPMENT) {
  // @ts-expect-error custom event for Vite WS plugin
  process.emit('orchestrel:httpServer', httpServer);
} else if (pendingAttachWs) {
  pendingAttachWs(httpServer);
}
