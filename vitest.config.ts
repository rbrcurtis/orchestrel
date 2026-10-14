import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsoaPath = require.resolve('tsoa');

// Force NODE_ENV=test so React loads development builds (React.act lives
// in react-dom/test-utils.development.js). Shells that export NODE_ENV=production
// otherwise break @testing-library/react's act() under React 19.
process.env.NODE_ENV = 'test';

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      tsoa: tsoaPath,
      // This root suite also collects desktop/main tests (no exclude for
      // desktop/). They import 'electron' — the npm package, which exports a
      // binary path, not the runtime — so main.ts's module-scope boot code
      // crashes collection. Alias to the same stub the desktop runner uses.
      electron: fileURLToPath(new URL('./desktop/electron-stub.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/.worktrees/**', '**/.claude/worktrees/**'],
    server: {
      deps: {
        inline: ['tsoa', '@tsoa/runtime'],
      },
    },
  },
});
