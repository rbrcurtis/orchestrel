import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { wsServerPlugin } from "./src/server/ws/server";

function pwaLogPlugin(): Plugin {
  return {
    name: 'pwa-log',
    configureServer(server) {
      server.middlewares.use('/api/pwa-log', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk; });
          req.on('end', () => {
            try {
              const { msg, ts } = JSON.parse(body);
              console.log(`[pwa-log ${ts}] ${msg}`);
            } catch {
              console.log(`[pwa-log] ${body}`);
            }
            res.writeHead(200);
            res.end('ok');
          });
        } else {
          res.writeHead(405);
          res.end();
        }
      });
    },
  };
}

export default defineConfig(({ isSsrBuild }) => ({
  build: {
    rollupOptions: isSsrBuild
      ? {
          input: "./server/app.ts",
        }
      : undefined,
  },
  server: {
    port: Number(process.env.PORT) || 6194,
    host: process.env.HOST || '0.0.0.0',
    allowedHosts: true,
  },
  plugins: [wsServerPlugin(), pwaLogPlugin(), tailwindcss(), reactRouter(), tsconfigPaths()],
}));
