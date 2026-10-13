import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from 'vitest'
import { buildCliHome, installShim, nodeNameFor, type CliHome } from './shim'

const pexecFile = promisify(execFile)
const IS_POSIX = platform() !== 'win32'

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

interface Harness {
  srcDir: string
  nodeBin: string
  kppBundle: string
  modulesRoot: string
  sqliteSrc: string
  homeDir: string
  userData: string
}

// userData intentionally contains a space: the script must quote every path.
async function harness(): Promise<Harness> {
  const srcDir = await tmp('shim-src-')
  // Fake nodeBin = the real node binary, so the integration test runs for real.
  const nodeBin = process.execPath
  writeFileSync(join(srcDir, 'kpp.bundle.mjs'), 'console.log("kpp v1")\n')
  // Fake module trees shaped like the real out/node_modules: better-sqlite3
  // (package.json + the native addon at the exact marker path installShim
  // staleness-checks) plus its pure-JS loader peers.
  const modulesRoot = join(srcDir, 'node_modules')
  const sqliteSrc = join(modulesRoot, 'better-sqlite3')
  const release = join(sqliteSrc, 'build', 'Release')
  mkdirSync(release, { recursive: true })
  writeFileSync(join(sqliteSrc, 'package.json'), '{"name":"better-sqlite3"}\n')
  writeFileSync(join(release, 'better_sqlite3.node'), 'fake-native-v1')
  for (const p of ['bindings', 'file-uri-to-path']) {
    mkdirSync(join(modulesRoot, p), { recursive: true })
    writeFileSync(join(modulesRoot, p, 'package.json'), `{"name":"${p}"}`)
  }
  const homeDir = await tmp('shim-home-')
  const userData = join(homeDir, 'a b', 'Orchestrel')
  return { srcDir, nodeBin, kppBundle: join(srcDir, 'kpp.bundle.mjs'), modulesRoot, sqliteSrc, homeDir, userData }
}

function targets(h: { homeDir: string }, posix: boolean) {
  return posix
    ? {
        cliHome: join(h.homeDir, '.local', 'share', 'orchestrel'),
        binPath: join(h.homeDir, '.local', 'bin', 'orchestrel'),
      }
    : {
        cliHome: join(h.homeDir, 'Local', 'AppData', 'orchestrel'),
        binPath: join(h.homeDir, 'Local', 'AppData', 'orchestrel', 'orchestrel.cmd'),
      }
}

test('nodeNameFor maps win32 to node.exe and everything else to node', () => {
  expect(nodeNameFor('win32')).toBe('node.exe')
  expect(nodeNameFor('linux')).toBe('node')
  expect(nodeNameFor('darwin')).toBe('node')
})

test('scriptContent quotes paths with spaces', () => {
  const homeDir = '/tmp/h'
  const userData = '/tmp/a b/Orchestrel'
  const home = buildCliHome(userData, '/opt/node', '/opt/kpp.bundle.mjs', homeDir)
  const t = targets({ homeDir }, true)
  expect(home.cliHome).toBe(t.cliHome)
  expect(home.binPath).toBe(t.binPath)
  expect(home.scriptContent).toContain(`"${join(t.cliHome, 'node')}"`)
  expect(home.scriptContent).toContain(`"${join(t.cliHome, 'kpp.bundle.mjs')}"`)
  expect(home.scriptContent).toContain(`"${userData}/kiro/config.json"`)
  expect(home.scriptContent).toContain('KPP_CONFIG=')
})

test('installShim is idempotent', async () => {
  const h = await harness()
  const { cliHome, binPath } = targets(h, IS_POSIX)
  const home = buildCliHome(h.userData, h.nodeBin, h.kppBundle, h.homeDir)
  const opts = {
    nodeBin: h.nodeBin,
    kppBundle: h.kppBundle,
    sqliteModulesRoot: h.modulesRoot,
    binPath,
    homeDir: h.homeDir,
  }
  try {
    const first = await installShim(home, opts)
    expect(first.changed).toBe(true)
    expect(await stat(join(cliHome, 'node'))).toBeDefined()
    expect(readFileSync(join(cliHome, 'kpp.bundle.mjs'), 'utf8')).toContain('kpp v1')
    // The better-sqlite3 tree must ship into cliHome/node_modules, complete
    // with the native addon at the marker path, plus the pure-JS loader peers.
    expect(
      readFileSync(join(cliHome, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8')
    ).toContain('better-sqlite3')
    expect(
      readFileSync(
        join(cliHome, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
        'utf8'
      )
    ).toBe('fake-native-v1')
    for (const p of ['bindings', 'file-uri-to-path']) {
      expect(
        readFileSync(join(cliHome, 'node_modules', p, 'package.json'), 'utf8')
      ).toContain(`"name":"${p}"`)
    }
    if (IS_POSIX) {
      expect((await stat(binPath)).mode & 0o777).toBe(0o755)
    }

    const second = await installShim(home, opts)
    expect(second.changed).toBe(false)

    // Zero rewrites: a third call leaves every artifact mtime untouched
    // (bundle, and the module tree's marker file).
    const m1 = await stat(join(cliHome, 'kpp.bundle.mjs'))
    const q1 = await stat(
      join(cliHome, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    )
    await installShim(home, opts)
    const m2 = await stat(join(cliHome, 'kpp.bundle.mjs'))
    const q2 = await stat(
      join(cliHome, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    )
    expect(m2.mtimeMs).toBe(m1.mtimeMs)
    expect(q2.mtimeMs).toBe(q1.mtimeMs)
  } finally {
    await rm(h.srcDir, { recursive: true, force: true })
    await rm(h.homeDir, { recursive: true, force: true })
  }
})

test('installShim repairs a stale bundle after app move', async () => {
  const h = await harness()
  const { cliHome, binPath } = targets(h, IS_POSIX)
  const home = buildCliHome(h.userData, h.nodeBin, h.kppBundle, h.homeDir)
  const opts = {
    nodeBin: h.nodeBin,
    kppBundle: h.kppBundle,
    sqliteModulesRoot: h.modulesRoot,
    binPath,
    homeDir: h.homeDir,
  }
  try {
    await installShim(home, opts)
    // Simulate an app update replacing the bundle (new content ⇒ new mtime).
    writeFileSync(h.kppBundle, 'console.log("kpp v2")\n')
    await new Promise(r => setTimeout(r, 20))
    const res = await installShim(home, opts)
    expect(res.changed).toBe(true)
    expect(readFileSync(join(cliHome, 'kpp.bundle.mjs'), 'utf8')).toContain('kpp v2')
  } finally {
    await rm(h.srcDir, { recursive: true, force: true })
    await rm(h.homeDir, { recursive: true, force: true })
  }
})

test('installShim repairs a stale better-sqlite3 module tree', async () => {
  const h = await harness()
  const { cliHome, binPath } = targets(h, IS_POSIX)
  const home = buildCliHome(h.userData, h.nodeBin, h.kppBundle, h.homeDir)
  const opts = {
    nodeBin: h.nodeBin,
    kppBundle: h.kppBundle,
    sqliteModulesRoot: h.modulesRoot,
    binPath,
    homeDir: h.homeDir,
  }
  try {
    await installShim(home, opts)
    // Simulate an app update shipping a new addon: new content + new mtime on
    // the marker file, a second tree file to prove the WHOLE dir is re-copied
    // (a stale dest marker with a missing fresh file must not survive).
    const marker = join(h.sqliteSrc, 'build', 'Release', 'better_sqlite3.node')
    const extra = join(h.sqliteSrc, 'lib', 'new-file.js')
    mkdirSync(join(h.sqliteSrc, 'lib'), { recursive: true })
    writeFileSync(marker, 'fake-native-v2-longer')
    writeFileSync(extra, '// new file shipped in the update\n')
    const s = await stat(marker)
    await utimes(marker, s.atime, new Date(s.mtimeMs + 60_000))
    const res = await installShim(home, opts)
    expect(res.changed).toBe(true)
    const dstMarker = join(cliHome, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    expect(readFileSync(dstMarker, 'utf8')).toBe('fake-native-v2-longer')
    expect(readFileSync(join(cliHome, 'node_modules', 'better-sqlite3', 'lib', 'new-file.js'), 'utf8')).toContain(
      'new file'
    )
    // Repair is idempotent afterwards.
    expect((await installShim(home, opts)).changed).toBe(false)
  } finally {
    await rm(h.srcDir, { recursive: true, force: true })
    await rm(h.homeDir, { recursive: true, force: true })
  }
})

test('shim actually runs the bundled KPP CLI', async () => {
  const h = await harness()
  const { cliHome, binPath } = targets(h, IS_POSIX)
  const home = buildCliHome(h.userData, h.nodeBin, h.kppBundle, h.homeDir)
  const opts = {
    nodeBin: h.nodeBin,
    kppBundle: h.kppBundle,
    sqliteModulesRoot: h.modulesRoot,
    binPath,
    homeDir: h.homeDir,
  }
  try {
    if (IS_POSIX) {
      // Stub KPP bundle: echo arg + resolved KPP_CONFIG back.
      writeFileSync(h.kppBundle, [
        'const cfg = process.env.KPP_CONFIG ?? \'none\';',
        'console.log(process.argv[2] + \',\' + cfg);',
      ].join('\n'))
      await installShim(home, opts)
      const { stdout } = await pexecFile(binPath, ['status'], { encoding: 'utf8', timeout: 30000 })
      expect(stdout).toContain('status')
      expect(stdout).toContain(h.userData + '/kiro/config.json')
    } else {
      // Non-posix runners pin the batch CONTENT instead of executing it. The
      // node binary is a copy of the running machine's binary, so its name is
      // the running platform's: node.exe only on win32.
      await installShim(home, opts)
      const content = readFileSync(binPath, 'utf8')
      const node = nodeNameFor(process.platform)
      expect(content).toContain(node)
      expect(content).toContain('kpp.bundle.mjs')
      expect(content).toContain('KPP_CONFIG=')
      expect(content).toContain('%%*')
    }
  } finally {
    await rm(h.srcDir, { recursive: true, force: true })
    await rm(h.homeDir, { recursive: true, force: true })
  }
})
