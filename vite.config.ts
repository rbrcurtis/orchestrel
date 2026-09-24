import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { wsServerPlugin } from "./src/server/ws/server";

// public/sw.js ships a `__SW_VERSION__` token in its cache name. Give every
// server boot and every production build a fresh value so the activate handler
// purges the previous cache: a cache that holds a bad bundle can never outlive
// the deploy that fixes it.
function swVersionPlugin(): Plugin {
  const version = `${gitSha()}-${Date.now().toString(36)}`;

  return {
    name: "sw-version",

    // Ryan's instance is served by the Vite dev server, so /sw.js is a static
    // file from public/ that never touches a build. Inject the token here.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/sw.js") return next();
        const source = readFileSync(resolve("public/sw.js"), "utf8");
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-cache");
        res.end(source.replaceAll("__SW_VERSION__", version));
      });
    },

    // Production (cecil) serves build/client, where public/ is copied verbatim.
    closeBundle() {
      const file = resolve("build/client/sw.js");
      if (!existsSync(file)) return;
      writeFileSync(file, readFileSync(file, "utf8").replaceAll("__SW_VERSION__", version));
    },
  };
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "nogit";
  }
}

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
  optimizeDeps: {
    noDiscovery: true,
    include: [
      'react', 'react/jsx-runtime', 'react/jsx-dev-runtime',
      'react-dom', 'react-dom/client', 'react-router', 'react-router/dom',
      'mobx', 'mobx-react-lite', 'lucide-react', 'radix-ui',
      '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities',
      'class-variance-authority', 'clsx', 'tailwind-merge',
      'idb-keyval', 'zod', 'react-markdown', 'remark-gfm',
      'socket.io-client',
      // CJS dep reached through @earendil-works/pi-ai's ESM files; must be
      // pre-bundled for browser named-export interop.
      'partial-json',
    ],
  },
  server: {
    port: Number(process.env.PORT) || 6194,
    host: process.env.HOST || '0.0.0.0',
    allowedHosts: true,
    watch: {
      // src/orcd is a standalone daemon (layer 3) with its own systemd lifecycle —
      // Vite watching it triggers full browser reloads via the shared src/shared/*
      // module graph, which is pure noise for frontend HMR.
      //
      // Card sessions can also develop in generated worktrees under this repo.
      // Those copies include the same src/shared modules, so watching them makes
      // this dev server reload for changes that belong to another session.
      ignored: [
        '**/.worktrees/**',
        '**/.claude/worktrees/**',
        '**/data/**',
        '**/.react-router/**',
        '**/src/orcd/**',
      ],
    },
  },
  plugins: [
    swVersionPlugin(),
    wsServerPlugin(),
    pwaLogPlugin(),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
}));
