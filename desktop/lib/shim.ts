// Installs the `orchestrel` CLI shim so `orchestrel kiro login` works with the
// app closed. The shim lives at a STABLE path (outside the versioned app
// bundle) and executes a snapshot of the bundled node + kpp.bundle.mjs + the
// better-sqlite3 module tree copied into cliHome. kpp.bundle.mjs declares
// better-sqlite3 external and resolves it from cliHome/node_modules, so the
// module tree is part of the shim — without it every CLI call dies with
// ERR_MODULE_NOT_FOUND and auth with the app closed is impossible. App
// updates replace the source bundles, so installShim re-copies only when a
// source changed (size+mtime compare) — repair semantics; a no-change run is
// a zero-rewrite no-op. The bin script is rewritten atomically (temp +
// rename) only when its content would change.
import { copyFileSync, cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  // Root of the bundled node_modules (out/node_modules): better-sqlite3 and
  // its loader peers live under it, each copied to cliHome/node_modules/.
  sqliteModulesRoot: string
  binPath: string
  // Sanctioned seam: production passes os.homedir(); tests point HOME at a
  // temp dir. buildCliHome also uses it to detect the platform's path shape.
  homeDir: string
}

const BUNDLE = 'kpp.bundle.mjs'
const CONFIG_REL = 'kiro/config.json'
// Better-sqlite3 is not self-contained at runtime: its native loader goes
// through the `bindings` and `file-uri-to-path` packages (and file-uri-to-
// path needs its peer `process`). Those three ship beside better-sqlite3 in
// out/node_modules, so installShim copies them all under cliHome/node_modules.
const SQLITE_MODULE = 'better-sqlite3'
const SQLITE_PEERS: Array<[string, string]> = [
  ['bindings', 'package.json'],
  ['file-uri-to-path', 'package.json'],
]
// Each module tree's own copy marker: its native addon for better-sqlite3,
// package.json for the pure-JS peers — the piece a stale or half-shipped
// tree breaks first.
const SQLITE_MARKER_REL = 'build/Release/better_sqlite3.node'

// The shim's node is a copy of THIS machine's shipped binary, so its name
// follows the running platform: win32 builds the .exe.
export function nodeNameFor(p: NodeJS.Platform): string {
  return p === 'win32' ? 'node.exe' : 'node'
}

function isWin(): boolean {
  return homedir().includes('\\')
}

function shScript(cliHome: string, node: string, kppConfig: string): string {
  return [
    '#!/bin/sh',
    `export KPP_CONFIG="${kppConfig}"`,
    `exec "${join(cliHome, node)}" "${join(cliHome, BUNDLE)}" "$@"`,
    '',
  ].join('\n')
}

function batScript(cliHome: string, node: string, kppConfig: string): string {
  // Absolute paths everywhere (matches the POSIX approach); %%* forwards all args.
  return [
    '@echo off',
    `set "KPP_CONFIG=${kppConfig}"`,
    `"${join(cliHome, node)}" "${join(cliHome, BUNDLE)}" %%*`,
    '',
  ].join('\r\n')
}

export function buildCliHome(userDataDir: string, _nodeBin: string, _kppBundle: string, homeDir: string): CliHome {
  const win = isWin()
  const node = nodeNameFor(win ? 'win32' : 'linux')
  const cliHome = win
    ? join(homeDir, 'AppData', 'Local', 'orchestrel')
    : join(homeDir, '.local', 'share', 'orchestrel')
  const binPath = win
    ? join(cliHome, 'orchestrel.cmd')
    : join(homeDir, '.local', 'bin', 'orchestrel')
  const kppConfig = join(userDataDir, CONFIG_REL)
  const scriptContent = win ? batScript(cliHome, node, kppConfig) : shScript(cliHome, node, kppConfig)
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

async function copyFileIfStale(dest: string, src: string): Promise<boolean> {
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

// Directory copy under the same staleness contract as copyFileIfStale, but
// keyed to `markerRel`: comparing a single file is enough to detect a real
// update (an update always changes the addon's mtime and almost always its
// size), and per-file comparison across a whole tree would rewrite churn.
// After cpSync the marker's mtime is stamped `now` (not the source's), so it
// must be pinned back to the source mtime before returning — otherwise the
// next installShim sees dest≠src and re-copies the whole tree every boot.
async function copyDirIfStale(dest: string, src: string, markerRel: string): Promise<boolean> {
  const srcMarker = join(src, markerRel)
  const dstMarker = join(dest, markerRel)
  if (!(await stale(dstMarker, srcMarker))) return false
  await mkdir(dest, { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  const s = await stat(srcMarker)
  await utimes(dstMarker, s.atime, s.mtime)
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
  const node = isCmd ? 'node.exe' : 'node'
  await mkdir(home.cliHome, { recursive: true })
  let changed = false
  changed = (await copyFileIfStale(join(home.cliHome, node), opts.nodeBin)) || changed
  changed = (await copyFileIfStale(join(home.cliHome, BUNDLE), opts.kppBundle)) || changed
  const modulesDest = join(home.cliHome, 'node_modules')
  for (const [mod, markerRel] of [[SQLITE_MODULE, SQLITE_MARKER_REL], ...SQLITE_PEERS]) {
    const src = join(opts.sqliteModulesRoot, mod)
    // sqlite (and its native addon) must always ship: its absence is the
    // closed-app-auth killer. A missing peer is tolerated with a loud log
    // line — the loader chain still fails at runtime, but visibly, in the
    // shim's output rather than as a boot-time install crash.
    if (!existsSync(src)) {
      console.warn(`installShim: ${src} missing — skipping (CLI sqlite loads will fail until repaired)`)
      continue
    }
    changed = (await copyDirIfStale(join(modulesDest, mod), src, markerRel)) || changed
  }
  changed =
    (await writeIfChanged(opts.binPath, home.scriptContent, isCmd ? undefined : 0o755)) || changed
  return { changed }
}
