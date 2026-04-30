import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const tsoaPath = require.resolve('tsoa')

// Force NODE_ENV=test so React loads development builds (React.act lives
// in react-dom/test-utils.development.js). Shells that export NODE_ENV=production
// otherwise break @testing-library/react's act() under React 19.
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
