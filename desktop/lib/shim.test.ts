import { mkdtemp, rm, stat } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from 'vitest'
import { buildCliHome, installShim } from './shim'

const pexecFile = promisify(execFile)
const IS_POSIX = platform() !== 'win32'

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

interface Harness {
  srcDir: string
  nodeBin: string
  kppBundle: string
  homeDir: string
  userData: string
}

// userData intentionally contains a space: the script must quote every path.
async function harness(): Promise<Harness> {
  const srcDir = await tmp('shim-src-')
  // Fake nodeBin = the real node binary, so the integration test runs for real.
  const nodeBin = process.execPath
  writeFileSync(join(srcDir, 'kpp.bundle.mjs'), 'console.log("kpp v1")\n')
  const homeDir = await tmp('shim-home-')
  const userData = join(homeDir, 'a b', 'Orchestrel')
  return { srcDir, nodeBin, kppBundle: join(srcDir, 'kpp.bundle.mjs'), homeDir, userData }
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
  const opts = { nodeBin: h.nodeBin, kppBundle: h.kppBundle, binPath, homeDir: h.homeDir }
  try {
    const first = await installShim(home, opts)
    expect(first.changed).toBe(true)
    expect(await stat(join(cliHome, 'node'))).toBeDefined()
    expect(readFileSync(join(cliHome, 'kpp.bundle.mjs'), 'utf8')).toContain('kpp v1')
    if (IS_POSIX) {
      expect((await stat(binPath)).mode & 0o777).toBe(0o755)
    }

    const second = await installShim(home, opts)
    expect(second.changed).toBe(false)

    // Zero rewrites: a third call leaves every artifact mtime untouched.
    const m1 = await stat(join(cliHome, 'kpp.bundle.mjs'))
    await installShim(home, opts)
    const m2 = await stat(join(cliHome, 'kpp.bundle.mjs'))
    expect(m2.mtimeMs).toBe(m1.mtimeMs)
  } finally {
    await rm(h.srcDir, { recursive: true, force: true })
    await rm(h.homeDir, { recursive: true, force: true })
  }
})

test('installShim repairs a stale bundle after app move', async () => {
  const h = await harness()
  const { cliHome, binPath } = targets(h, IS_POSIX)
  const home = buildCliHome(h.userData, h.nodeBin, h.kppBundle, h.homeDir)
  const opts = { nodeBin: h.nodeBin, kppBundle: h.kppBundle, binPath, homeDir: h.homeDir }
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

test('shim actually runs the bundled KPP CLI', async () => {
  const h = await harness()
  const { cliHome, binPath } = targets(h, IS_POSIX)
  const home = buildCliHome(h.userData, h.nodeBin, h.kppBundle, h.homeDir)
  const opts = { nodeBin: h.nodeBin, kppBundle: h.kppBundle, binPath, homeDir: h.homeDir }
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
      // Non-posix runners pin the batch CONTENT instead of executing it.
      await installShim(home, opts)
      const content = readFileSync(binPath, 'utf8')
      // win32 join produces backslash paths; on POSIX runners this branch
      // won't run, but keep the expectations platform-neutral.
      expect(content).toContain('node')
      expect(content).toContain('kpp.bundle.mjs')
      expect(content).toContain('KPP_CONFIG=')
      expect(content).toContain('%%*')
    }
  } finally {
    await rm(h.srcDir, { recursive: true, force: true })
    await rm(h.homeDir, { recursive: true, force: true })
  }
})
