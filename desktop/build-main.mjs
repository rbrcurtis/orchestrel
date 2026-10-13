// Build the Electron main-process bundle: main/*.ts → dist/main.cjs + the
// two preloads, CJS (Electron's main-process entry is CommonJS today),
// bundled so dist/ is the only thing the packaged app needs beside out/.
// electron itself stays external — it is the runtime, not a dependency.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const esbuild = await import(join(here, 'node_modules', 'esbuild', 'lib', 'main.js'))

await Promise.all([
  ...['main', 'preload', 'crash-preload'].map((entry) =>
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
  ),
  // The DB DDL single source of truth (lib/provision-dll.ts) as a tiny CJS
  // bundle that provision-db.cjs requires at runtime (out/ gets a copy via
  // build-bundles.mjs). Keeps the SQL in one TS module, importable by both
  // the provisioner and the drift test.
  esbuild.build({
    entryPoints: [join(here, 'lib', 'provision-dll.ts')],
    outfile: join(here, 'dist', 'provision-dll-bundle.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
  }),
])
console.log('build-main: dist/main.cjs, dist/preload.cjs, dist/crash-preload.cjs, dist/provision-dll-bundle.cjs')
