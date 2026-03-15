import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const tsoaPath = require.resolve('tsoa')

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      tsoa: tsoaPath,
    },
  },
  test: {
    globals: true,
    server: {
      deps: {
        inline: ['tsoa', '@tsoa/runtime'],
      },
    },
  },
})
