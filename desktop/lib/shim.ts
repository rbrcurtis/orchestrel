// Installs the `orchestrel` CLI shim so `orchestrel kiro login` works with the
// app closed. The shim lives at a STABLE path (outside the versioned app
// bundle) and executes a snapshot of the bundled node + kpp.bundle.mjs copied
// into cliHome. App updates replace the source bundle, so installShim
// re-copies only when the source changed (size+mtime compare) — repair
// semantics; a no-change run is a zero-rewrite no-op. The bin script is
// rewritten atomically (temp + rename) only when its content would change.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, stat, unlink, utimes } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CliHome {
  cliHome: string
  binPath: string
  scriptContent: string
}

export interface InstallOpts {
  nodeBin: string
  kppBundle: string
  binPath: string
  // Sanctioned seam: production passes os.homedir(); tests point HOME at a
  // temp dir. buildCliHome also uses it to detect the platform's path shape.
  homeDir: string
}

const BUNDLE = 'kpp.bundle.mjs'
const NODE = 'node'
const CONFIG_REL = 'kiro/config.json'

function isWin(): boolean {
  return homedir().includes('\\')
}

function shScript(cliHome: string, kppConfig: string): string {
  return [
    '#!/bin/sh',
    `export KPP_CONFIG="${kppConfig}"`,
    `exec "${join(cliHome, NODE)}" "${join(cliHome, BUNDLE)}" "$@"`,
    '',
  ].join('\n')
}

function batScript(cliHome: string, kppConfig: string): string {
  // Absolute paths everywhere (matches the POSIX approach); %%* forwards all args.
  return [
    '@echo off',
    `set "KPP_CONFIG=${kppConfig}"`,
    `"${join(cliHome, NODE)}" "${join(cliHome, BUNDLE)}" %%*`,
    '',
  ].join('\r\n')
}

export function buildCliHome(userDataDir: string, _nodeBin: string, _kppBundle: string, homeDir: string): CliHome {
  const win = isWin()
  const cliHome = win
    ? join(homeDir, 'Local', 'AppData', 'orchestrel')
    : join(homeDir, '.local', 'share', 'orchestrel')
  const binPath = win
    ? join(cliHome, 'orchestrel.cmd')
    : join(homeDir, '.local', 'bin', 'orchestrel')
  const kppConfig = join(userDataDir, CONFIG_REL)
  const scriptContent = win ? batScript(cliHome, kppConfig) : shScript(cliHome, kppConfig)
  return { cliHome, binPath, scriptContent }
}

// Source-vs-dest divergence check; missing dest counts as divergent. Size is
// compared first so an unchanged multi-hundred-MB node binary is never
// byte-compared, and mtime catches content changes between copies. A copy
// pinned via utimes can still land 1ms off the source mtime after rename on
// some filesystems, so an equal-size dest within 1ms is treated as unchanged
// (a real rewrite shifts mtime by far more). The tolerance is bounded: it only
// applies when sizes already match, so a genuine same-size content change
// (different mtime) is still caught.
async function stale(dest: string, src: string): Promise<boolean> {
  let d
  try {
    d = await stat(dest)
  } catch {
    return true
  }
  const s = await stat(src)
  if (d.size !== s.size) return true
  return Math.abs(d.mtimeMs - s.mtimeMs) > 1
}

async function copyIfStale(dest: string, src: string): Promise<boolean> {
  if (!(await stale(dest, src))) return false
  await mkdir(join(dest, '..'), { recursive: true })
  const t = dest + '.tmp'
  try {
    // copyFileSync, not hardlink: the asar-unpacked source can vanish mid
    // app-update, leaving a hardlinked dest dangling.
    copyFileSync(src, t)
    // copyFileSync stamps dest mtime=now, which would make every subsequent
    // stale-check false-positive; pin it to the source mtime so the
    // mtime+size compare is stable across installs.
    const s = await stat(src)
    await utimes(t, s.atime, s.mtime)
    renameSync(t, dest)
  } catch (e) {
    if (existsSync(t)) await unlink(t)
    throw e
  }
  return true
}

async function writeIfChanged(path: string, content: string, mode?: number): Promise<boolean> {
  try {
    if (readFileSync(path, 'utf8') === content) return false
  } catch {
    // missing → rewrite
  }
  await mkdir(join(path, '..'), { recursive: true })
  const t = path + '.tmp'
  writeFileSync(t, content)
  renameSync(t, path)
  if (mode !== undefined) await chmod(path, mode)
  return true
}

export async function installShim(home: CliHome, opts: InstallOpts): Promise<{ changed: boolean }> {
  const isCmd = home.binPath.endsWith('.cmd')
  await mkdir(home.cliHome, { recursive: true })
  let changed = false
  changed = (await copyIfStale(join(home.cliHome, NODE), opts.nodeBin)) || changed
  changed = (await copyIfStale(join(home.cliHome, BUNDLE), opts.kppBundle)) || changed
  changed =
    (await writeIfChanged(opts.binPath, home.scriptContent, isCmd ? undefined : 0o755)) || changed
  return { changed }
}
