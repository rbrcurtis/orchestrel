import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const tsoaPath = require.resolve('tsoa')

// React 19 only exports `act` in development/test CJS builds.
// Force NODE_ENV before any CJS require() condition checks.
process.env.NODE_ENV = 'test'

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      tsoa: tsoaPath,
    },
  },
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/.worktrees/**'],
    server: {
      deps: {
        inline: ['tsoa', '@tsoa/runtime'],
      },
    },
  },
})
