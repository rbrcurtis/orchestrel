import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// main.ts imports 'electron'. Under vitest that resolves to the empty stub
// (electron-stub.ts) so main.test.ts can collect the pure functions without
// the electron runtime; esbuild keeps the real electron external (build-main.mjs).
export default defineConfig({
  test: {
    environment: 'node'
  },
  resolve: {
    alias: {
      electron: fileURLToPath(new URL('./electron-stub.ts', import.meta.url))
    }
  }
})
