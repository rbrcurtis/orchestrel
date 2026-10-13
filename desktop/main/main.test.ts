// Tests for the pure slice of the Electron main entry: the ServiceDef spawn
// recipes (exact env/cwd/args), the outDirFor dev/packaged branches, and the
// native-module import ban over the whole main + lib surface.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { BootstrapData } from '../lib/bootstrap'
import type { ServiceDef } from '../lib/supervisor'
import { outDirFor, serviceDefsFromBootstrap } from './main'

// The compiled dist/main.cjs and this main/ dir share a parent (desktop/),
// so out/ is reachable from either as <parent>/out — the same distance the
// production bundle uses.
const PKG_DIR = join(__dirname, '..')

// Space in the path pins the Review-Focus quoting line at the spawn-recipe
// level: the supervisor passes these strings straight to spawn with array
// args, so they must be exact and absolute here.
const OUT = '/tmp/orc out dir'
const NODE_BIN = '/tmp/orc out dir/node/node'
const USER_DATA = '/home/u/app data/Orchestrel'
const BOOT: BootstrapData = { backendPort: 41000, kppPort: 42000, orcdPort: 43000, authToken: 'token' }

test('serviceDefsFromBootstrap maps all three services with the exact env, cwd, args', () => {
  const [kpp, orcd, backend] = serviceDefsFromBootstrap(BOOT, OUT, NODE_BIN, USER_DATA)

  expect(kpp).toEqual({
    id: 'kpp',
    command: NODE_BIN,
    args: [join(OUT, 'kpp.bundle.mjs'), 'serve'],
    env: { KPP_CONFIG: join(USER_DATA, 'kiro', 'config.json') },
    cwd: OUT,
  })
  expect(orcd).toEqual({
    id: 'orcd',
    command: NODE_BIN,
    args: [join(OUT, 'orcd.bundle.mjs')],
    env: { ORC_CONFIG: join(USER_DATA, 'orcd.yaml') },
    cwd: USER_DATA,
  })
  expect(backend).toEqual({
    id: 'backend',
    command: NODE_BIN,
    args: [join(OUT, 'server.bundle.mjs')],
    env: {
      PORT: '41000',
      HOST: '127.0.0.1',
      CLIENT_DIR: join(OUT, 'client'),
      ORC_NODES: join(USER_DATA, 'orc.yaml'),
    },
    cwd: USER_DATA,
  })
})

test('outDirFor uses plain <pkg>/out in dev and asar.unpacked when packaged', () => {
  const prev = process.env.ELECTRON_IS_ASAR
  try {
    delete process.env.ELECTRON_IS_ASAR
    expect(outDirFor()).toBe(join(PKG_DIR, 'out'))
    process.env.ELECTRON_IS_ASAR = '1'
    // Task 8 swaps this one function for resourcesPath-based resolution; the
    // mocked process.resourcesPath documents the packaged path shape.
    const orig = process.resourcesPath
    Object.defineProperty(process, 'resourcesPath', { value: '/x/resources', configurable: true })
    expect(outDirFor()).toBe('/x/resources/app.asar.unpacked/out')
    Object.defineProperty(process, 'resourcesPath', { value: orig, configurable: true })
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_IS_ASAR
    else process.env.ELECTRON_IS_ASAR = prev
  }
})

// The Electron main process must never pull in a native module: a
// better-sqlite3 (or any .node addon) require in main/lib would load the
// host's ABI build inside the electron process and crash on upgrade. Scan
// every source file, not a hardcoded file list, so new files are covered too.
// The scan matches an import/require whose SPECIFIER is a native module or a
// .node addon — the literal strings used by this test file itself (in a
// comment or a regex) are not specifiers, so they must not trip it.
test('desktop/main and desktop/lib never import a native module', () => {
  const SPECIFIER = /(?:\brequire\s*\(\s*|\bfrom\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/g
  const offenders: string[] = []
  const NATIVE_SPEC = /^(?:better-sqlite3|.*\.node)$/.source
  for (const dir of ['main', 'lib']) {
    for (const f of walk(join(PKG_DIR, dir))) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(SPECIFIER)) {
        const spec = m[1]!
        if (spec === 'better-sqlite3' || /\.node$/.test(spec)) offenders.push(`${f}:${spec}`)
      }
    }
  }
  expect(offenders).toEqual([])
  // the scan itself must have seen the whole surface
  expect(walk(join(PKG_DIR, 'lib')).some((f) => f.endsWith('supervisor.ts'))).toBe(true)
  expect(new RegExp(NATIVE_SPEC).test('better-sqlite3')).toBe(true)
  expect(new RegExp(NATIVE_SPEC).test('/x/y.node')).toBe(true)
})

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walk(p)
    return p.endsWith('.ts') ? [p] : []
  })
}
