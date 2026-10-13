// Build the Electron main-process bundle: main/*.ts → dist/main.cjs + the
// two preloads, CJS (Electron's main-process entry is CommonJS today),
// bundled so dist/ is the only thing the packaged app needs beside out/.
// electron itself stays external — it is the runtime, not a dependency.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const esbuild = await import(join(here, 'node_modules', 'esbuild', 'lib', 'main.js'))

await Promise.all(
  ['main', 'preload', 'crash-preload'].map((entry) =>
    esbuild.build({
      entryPoints: [join(here, 'main', `${entry}.ts`)],
      outfile: join(here, 'dist', `${entry}.cjs`),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      target: 'node22',
      sourcemap: false,
    })
  )
)
console.log('build-main: dist/main.cjs, dist/preload.cjs, dist/crash-preload.cjs')
