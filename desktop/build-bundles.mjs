// Bundle build for the self-contained desktop app. Turns the existing TS
// sources into three runnable plain-Node ESM bundles in <OUT_DIR> (default
// desktop/out):
//   server.bundle.mjs  — the orc backend (entry ../server.js)
//   orcd.bundle.mjs    — the node daemon (entry ../src/orcd/index.ts)
//   kpp.bundle.mjs     — kiro-pool-proxy (entry <KPP_REPO>/src/cli.ts)
// plus the bundled Node runtime (<OUT_DIR>/node/) and the prebuilt
// better-sqlite3 module beside the bundles (<OUT_DIR>/node_modules/). The SPA
// build (../build/client) is copied to <OUT_DIR>/client. The desktop app must
// never require a repo checkout at runtime: esbuild inlines every JS source
// (bundle: true); the only non-inlined things are native/heavy runtime deps,
// shipped in <OUT_DIR>/node_modules (better-sqlite3 + its loader deps) and
// declared EXTERNALS (better-sqlite3 everywhere; the pi agent SDK for orcd).
//
// Env: OUT_DIR (output dir, default desktop/out), KPP_REPO (fallback: the
// pinned local checkout), SKIP_NODE_DOWNLOAD=1, SKIP_SQLITE_PREBUILD=1
// (tests run offline). Flag: --force re-downloads the Node runtime.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Pinned: the Node runtime the desktop app ships. Latest LTS v22 as of
// 2026-10-13 — bump here (one constant) when it moves.
const NODE_VERSION = 'v22.23.3'
// KPP is a pinned local dependency — the repos stay independent, one source
// of truth, so the script bundles from the checkout (never a vendored copy).
const KPP_REPO_DEFAULT = '/home/ryan/Code/kiro-pool-proxy'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const OUT_DIR = process.env.OUT_DIR ?? join(here, 'out')
const KPP_REPO = process.env.KPP_REPO ?? KPP_REPO_DEFAULT
const FORCE = process.argv.includes('--force')
const SPA_SRC = join(root, 'build', 'client')

// Non-inlined deps per bundle. better-sqlite3 is a native addon, loaded at
// runtime from <OUT_DIR>/node_modules. orcd inlines the whole pi agent SDK
// (the brief's "same options" would have left it external and unresolvable
// from out/, since the repo's node_modules isn't shipped — inlining keeps the
// bundle self-contained, which is the plan's core constraint).
// The server bundle's entry (server.js) has top-level await, and Node refuses
// to load a single ESM file that mixes `__dirname`/`__filename` with top-level
// await (ERR_AMBIGUOUS_MODULE_SYNTAX). Two inlined CJS deps do exactly that:
//  - `app-root-path` (pulled in by typeorm) reads `__dirname` at module top
//    level. typeorm only reads its `.path`, so a tiny ESM shim is faithful.
//  - `tsoa` (star-exports the @tsoa/cli codegen toolchain -> typescript, which
//    uses `__filename`). At runtime the backend only needs @tsoa/runtime, so
//    alias `tsoa` onto it — same decorators, minus the codegen surface.
// Both aliases are inlined by esbuild, so they need no runtime copy.
const APP_ROOT_PATH_SHIM = join(here, 'shims', 'app-root-path-shim.mjs')
// Alias to an ABSOLUTE path, not a bare specifier: esbuild resolves alias
// targets relative to the *consuming* file, so 'tsoa' -> '@tsoa/runtime'
// only happened to work by walking up from server.js to the repo root's
// node_modules. Pin it to the root's node_modules explicitly.
const TSOA_RUNTIME = join(root, 'node_modules', '@tsoa', 'runtime')
if (!existsSync(join(TSOA_RUNTIME, 'package.json')))
  fail(`@tsoa/runtime not found at ${TSOA_RUNTIME} — run \`bun install\` in the repo root first.`)
const SERVER_ALIASES = {
  'app-root-path': APP_ROOT_PATH_SHIM,
  tsoa: TSOA_RUNTIME,
}

const EXTERNALS = {
  'server.bundle.mjs': ['better-sqlite3'],
  'orcd.bundle.mjs': [],
  'kpp.bundle.mjs': ['better-sqlite3'],
}

const ENTRIES = {
  'server.bundle.mjs': join(root, 'server.js'),
  'orcd.bundle.mjs': join(root, 'src', 'orcd', 'index.ts'),
  'kpp.bundle.mjs': join(KPP_REPO, 'src', 'cli.ts'),
}

function fail(msg) {
  console.error(`build-bundles: ${msg}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${r.status ?? `with ${r.signal}`} (per-entry detail above)`)
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

mkdirSync(OUT_DIR, { recursive: true })

// 1. The SPA must be built before it can be shipped.
if (!existsSync(join(SPA_SRC, 'index.html'))) {
  fail(`SPA build missing at ${join(SPA_SRC, 'index.html')} — run \`bun run build\` in the repo root first.`)
}

// 2. tsoa routes are generated into src/server/api/generated and must exist
// at bundle time (the backend imports routes.ts eagerly).
run('bun', ['run', 'tsoa:generate'], { cwd: root })

// 3. Bundle all three entries; a failure names the entry.
const esbuild = await import(join(here, 'node_modules', 'esbuild', 'lib', 'main.js'))
for (const [outName, entry] of Object.entries(ENTRIES)) {
  if (!existsSync(entry)) fail(`${outName}: entry missing at ${entry}`)
  try {
    await esbuild.build({
      entryPoints: [entry],
      outfile: join(OUT_DIR, outName),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: EXTERNALS[outName],
      alias: outName === 'server.bundle.mjs' ? SERVER_ALIASES : undefined,
      sourcemap: false,
      logLevel: 'warning',
      banner: {
        // Inlined CJS modules (express, typeorm, ...) call require() for
        // node builtins at runtime; ESM output needs a working require.
        js: "import { createRequire as __orcCreateRequire } from 'node:module'; const require = __orcCreateRequire(import.meta.url);",
      },
    })
    console.log(`bundled ${outName} <- ${entry}`)
  } catch (e) {
    fail(`esbuild failed for ${outName}:\n${e.message ?? e}`)
  }
}

// 4. Bundled Node runtime (download + extract once; --force re-fetches).
if (process.env.SKIP_NODE_DOWNLOAD === '1') {
  console.log('SKIP_NODE_DOWNLOAD=1 — skipping node runtime download')
} else {
  await installNodeRuntime()
}

// 5. better-sqlite3 native module for plain node (the bun ABI won't load).
if (process.env.SKIP_SQLITE_PREBUILD === '1') {
  console.log('SKIP_SQLITE_PREBUILD=1 — skipping better-sqlite3 prebuild')
} else {
  installSqlitePrebuild()
}

// 6. DB provisioner — the main process runs this in a child of the bundled
// node before the backend boots (the backend's migrations assume the base
// tables exist; it never creates them itself). The provisioner requires its
// DDL from provision-dll-bundle.cjs (generated from lib/provision-dll.ts by
// build-main.mjs); ship both.
for (const f of ['provision-db.cjs', 'provision-dll-bundle.cjs']) {
  const src = f === 'provision-dll-bundle.cjs' ? join(here, 'dist', f) : join(here, f)
  if (!existsSync(src)) fail(`${f} missing at ${src} — run \`node build-main.mjs\` first.`)
  copyFileSync(src, join(OUT_DIR, f))
  console.log(`copied ${f} -> out/`)
}

// 7. SPA assets.
rmSync(join(OUT_DIR, 'client'), { recursive: true, force: true })
cpSync(SPA_SRC, join(OUT_DIR, 'client'), { recursive: true })
console.log(`copied ${SPA_SRC} -> ${join(OUT_DIR, 'client')}`)

console.log(`build-bundles: done -> ${OUT_DIR}`)

// --- step implementations ---------------------------------------------------

async function installNodeRuntime() {
  const nodeDir = join(OUT_DIR, 'node')
  const nodeBin = join(nodeDir, 'bin', 'node')
  if (existsSync(nodeBin) && !FORCE) {
    console.log(`node runtime present (${nodeBin})`)
    return
  }
  const platTag = process.platform === 'win32' ? 'win' : process.platform
  const archTag = process.arch === 'arm64' ? 'arm64' : 'x64'
  const name = `node-${NODE_VERSION}-${platTag}-${archTag}.tar.xz`
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${name}`
  console.log(`downloading node ${NODE_VERSION} (${name})...`)
  const tmp = mkdtempSync(join(tmpdir(), 'orc-node-'))
  const tarball = join(tmp, name)
  try {
    const res = await fetch(url)
    if (!res.ok) fail(`node download failed: HTTP ${res.status} for ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(tarball, buf)
    // Verify against the official SHASUMS256.txt for this dist tag. Fail closed:
    // a verification we cannot complete (SHASUMS fetch fails, no matching
    // entry) is as bad as a mismatch — never ship an unverified tarball.
    const sumUrl = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`
    const sumRes = await fetch(sumUrl)
    if (!sumRes.ok) fail(`SHASUMS fetch failed: HTTP ${sumRes.status} for ${sumUrl} — cannot verify the node tarball, refusing to install an unverified download`)
    const sumText = await sumRes.text()
    const sumLine = sumText.split('\n').find((l) => l.includes(name))
    const want = sumLine?.trim().split(/\s+/)[0]
    if (!want) fail(`no SHASUMS256 entry for ${name} in ${sumUrl} — refusing to install an unverified download`)
    const got = sha256Hex(buf)
    if (want !== got) fail(`node tarball sha256 mismatch: expected ${want}, got ${got}`)
    // Stage the extract UNDER OUT_DIR, not in os.tmpdir(): /tmp can live on a
    // different filesystem (tmpfs on this host), and renameSync cannot move
    // the extracted dir across devices (EXDEV). Same-device staging makes the
    // final rename atomic and cross-device-proof.
    const stage = join(OUT_DIR, '.node-extract-tmp')
    mkdirSync(stage, { recursive: true })
    run('tar', ['-xJ', '-f', tarball, '-C', stage])
    const topDir = readdirSync(stage)[0]
    rmSync(nodeDir, { recursive: true, force: true })
    renameSync(join(stage, topDir), nodeDir)
    if (!existsSync(nodeBin)) fail(`node extraction produced no ${nodeBin}`)
    // The brief and Task 6's spawn recipe both address the binary as
    // <out>/node/<binname> (i.e. out/node/node on posix), not out/node/bin/node.
    // The tarball's real binary is bin/node, so add a hardlink at out/node/node
    // (fall back to a copy when hardlinks are unavailable, e.g. cross-device).
    const flatBin = join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node')
    if (!existsSync(flatBin)) {
      try {
        linkSync(nodeBin, flatBin)
      } catch {
        copyFileSync(nodeBin, flatBin)
      }
    }
    console.log(`node ${NODE_VERSION} -> ${nodeDir} (binary ${flatBin})`)
  } finally {
    // Staging leftovers on partial failure (a hash-mismatch abort happens
    // before the final rename) and the tarball, which may still be tens of MB.
    rmSync(join(OUT_DIR, '.node-extract-tmp'), { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  }
}

function installSqlitePrebuild() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const version = pkg.dependencies['better-sqlite3']
  if (!version) fail('root package.json has no better-sqlite3 dependency')
  console.log(`installing better-sqlite3@${version} (prebuilt, plain node runtime)...`)

  // Temp prefix: bun install (npm is broken on this host), prebuild-install
  // pinned to the plain node runtime, then copy the module (sources +
  // build/Release/*.node) into OUT_DIR.
  const tmp = mkdtempSync(join(tmpdir(), 'orc-sqlite-'))
  try {
    writeFileSync(join(tmp, 'package.json'), '{"name":"sqlite-prebuild","private":true,"version":"1.0.0"}\n')
    run('bun', ['install', `better-sqlite3@${version}`], { cwd: tmp })
    const modSrc = join(tmp, 'node_modules', 'better-sqlite3')
    // prebuild-install picks the ABI of the *ambient* node by default, which is
    // the wrong one when the host node differs from the shipped runtime (v22).
    // Force the pinned version so the .node always matches out/node.
    const nodeTarget = NODE_VERSION.slice(1) // v22.23.3 -> 22.23.3 (prebuild-install takes no leading v)
    run(join(modSrc, '..', '.bin', 'prebuild-install'), ['-r', 'node', '--target', nodeTarget], { cwd: modSrc })
    const native = join(modSrc, 'build', 'Release', 'better_sqlite3.node')
    if (!existsSync(native)) fail(`prebuild-install produced no native binary (looked for ${native})`)
    // better-sqlite3 is not self-contained at runtime: its native loader goes
    // through the `bindings` package (and `file-uri-to-path` beneath it). Ship
    // the whole temp-prefix node_modules (minus the .bin symlinks) so those
    // transitive deps resolve from out/node_modules next to the bundle.
    const nmSrc = join(tmp, 'node_modules')
    const nmDst = join(OUT_DIR, 'node_modules')
    rmSync(nmDst, { recursive: true, force: true })
    mkdirSync(nmDst, { recursive: true })
    for (const entry of readdirSync(nmSrc)) {
      if (entry === '.bin' || entry === '.modules' || entry === '.package-lock.json') continue
      cpSync(join(nmSrc, entry), join(nmDst, entry), { recursive: true })
    }
    // Validate the native module loads. Prefer the bundled node runtime — that is
    // the interpreter that will actually run the bundles at ship time; fall back
    // to the host node only when the runtime wasn't downloaded (offline tests).
    const nodeBin = join(OUT_DIR, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    const runner = existsSync(nodeBin) ? nodeBin : process.execPath
    const check = spawnSync(
      runner,
      ['-e', `require(${JSON.stringify(join(nmDst, 'better-sqlite3'))}); console.log('better-sqlite3 loads under', process.version)`],
      { cwd: OUT_DIR },
    )
    if (check.status !== 0) {
      fail(
        `bundled better-sqlite3 fails to load under ${runner}:\n${check.stdout?.toString() ?? ''}${check.stderr?.toString() ?? ''}`,
      )
    }
    console.log(`better-sqlite3 ${version} -> ${join(nmDst, 'better-sqlite3')}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
