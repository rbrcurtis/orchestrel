// Integration tests for the bundle build step (build-bundles.mjs). The build
// test runs the real script end-to-end with the network parts skipped
// (SKIP_NODE_DOWNLOAD / SKIP_SQLITE_PREBUILD), then the smoke test boots the
// produced server bundle with the HOST node and proves GET / serves the SPA
// from the bundled client dir pointed at by CLIENT_DIR.
import { execFileSync, execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, expect } from 'vitest'

// Base schema for a fresh temp DB: just enough for the backend's startup
// migrations (which ALTER the base tables) to succeed. Column set mirrors the
// production schema so no entity query hits a missing column at boot.
const BASE_SCHEMA = [
  'CREATE TABLE projects (',
  "  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,",
  '  name text NOT NULL,',
  '  path text NOT NULL,',
  "  setup_commands text DEFAULT '',",
  '  is_git_repo integer DEFAULT false NOT NULL,',
  '  default_branch text,',
  '  default_worktree integer DEFAULT false NOT NULL,',
  '  color text,',
  "  created_at text DEFAULT (datetime('now')) NOT NULL,",
  "  default_model text DEFAULT 'sonnet' NOT NULL,",
  "  default_thinking_level text DEFAULT 'high' NOT NULL,",
  "  provider_id text DEFAULT 'anthropic' NOT NULL,",
  "  node_name TEXT NOT NULL DEFAULT 'local',",
  '  archived INTEGER NOT NULL DEFAULT 0,',
  '  default_sandbox INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE TABLE cards (',
  '  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,',
  '  title text NOT NULL,',
  "  description text DEFAULT '',",
  "  column text DEFAULT 'backlog' NOT NULL,",
  '  position real DEFAULT 0 NOT NULL,',
  '  project_id integer REFERENCES projects(id) ON DELETE SET NULL,',
  '  pr_url text,',
  '  session_id text,',
  '  worktree_branch text,',
  '  source_branch text,',
  '  prompts_sent integer DEFAULT 0 NOT NULL,',
  '  turns_completed integer DEFAULT 0 NOT NULL,',
  "  created_at text DEFAULT (datetime('now')) NOT NULL,",
  "  updated_at text DEFAULT (datetime('now')) NOT NULL,",
  "  model text DEFAULT 'sonnet' NOT NULL,",
  "  thinking_level text DEFAULT 'high' NOT NULL,",
  '  context_tokens INTEGER NOT NULL DEFAULT 0,',
  '  context_window INTEGER NOT NULL DEFAULT 200000,',
  "  provider TEXT NOT NULL DEFAULT 'anthropic',",
  "  node_name TEXT NOT NULL DEFAULT 'local',",
  '  queue_position INTEGER DEFAULT NULL,',
  '  pending_prompt TEXT DEFAULT NULL,',
  '  pending_files TEXT DEFAULT NULL,',
  '  summarize_threshold REAL NOT NULL DEFAULT 0,',
  '  sandbox INTEGER NOT NULL DEFAULT 0,',
  '  sleep_until INTEGER DEFAULT NULL,',
  '  sleep_prompt TEXT DEFAULT NULL',
  ');',
].join('\n')

const SCRIPT = join(import.meta.dirname, 'build-bundles.mjs')
const OUT = join(import.meta.dirname, 'out')
// Test-owned out dir so the assertion proves the OUT_DIR env is honored.
const TEST_OUT = join(import.meta.dirname, '.test-out')

const BUNDLE_ENV = {
  ...process.env,
  KPP_REPO: '/home/ryan/Code/kiro-pool-proxy',
  SKIP_NODE_DOWNLOAD: '1',
  SKIP_SQLITE_PREBUILD: '1',
}

const tempDirs = []
function makeTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true })
})

function build(outDir) {
  execFileSync(process.execPath, [SCRIPT], { stdio: 'inherit', env: { ...BUNDLE_ENV, OUT_DIR: outDir } })
}

test('build-bundles produces all five outputs', () => {
  rmSync(TEST_OUT, { recursive: true, force: true })
  build(TEST_OUT)
  for (const f of ['server.bundle.mjs', 'orcd.bundle.mjs', 'kpp.bundle.mjs']) {
    expect(statSync(join(TEST_OUT, f)).size, f).toBeGreaterThan(0)
  }
  expect(existsSync(join(TEST_OUT, 'client', 'index.html'))).toBe(true)
}, 180_000)

test('server.bundle.mjs boots with CLIENT_DIR pointing at out/client', async () => {
  if (!existsSync(join(OUT, 'server.bundle.mjs'))) build(OUT)

  // free port
  const net = await import('node:net')
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = srv.address()?.port
      srv.close(() => (p ? resolve(p) : reject(new Error('no port'))))
    })
    srv.on('error', reject)
  })

  // temp cwd so data/orchestrel.db lands in temp; ORC_NODES with zero servers
  // (the backend connects per-node at init, so an empty list boots cleanly).
  // The backend opens the DB with synchronize:false and assumes the projects/
  // cards tables exist (managed out-of-band in production), so provision the
  // minimal schema the way a fresh install would.
  const cwd = makeTemp('orc-boot-')
  writeFileSync(join(cwd, 'orc.yaml'), 'servers: []\n')
  mkdirSync(join(cwd, 'data'), { recursive: true })
  // Pipe the DDL via stdin (not as an argv string) so the multi-line schema
  // arrives verbatim — string interpolation would mangle the newlines/quotes.
  execSync(`sqlite3 ${join(cwd, 'data', 'orchestrel.db')}`, {
    input: BASE_SCHEMA,
    stdio: ['pipe', 'inherit', 'inherit'],
  })

  const child = spawn(process.execPath, [join(OUT, 'server.bundle.mjs')], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...BUNDLE_ENV,
      CLIENT_DIR: join(OUT, 'client'),
      PORT: String(port),
      HOST: '127.0.0.1',
      ORC_NODES: join(cwd, 'orc.yaml'),
    },
  })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  child.stdout.resume()

  try {
    let body = ''
    let status = 0
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`)
        status = res.status
        body = await res.text()
        if (status === 200) break
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`server did not boot:\n${stderr}`)
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(status).toBe(200)
    // The SPA has no static <div id= root — React Router mounts by streaming
    // context scripts into an empty <body>. These markers are present in both
    // the built index.html and the server-streamed response.
    expect(body).toContain('__reactRouterContext')
    expect(body).toContain('serviceWorker')
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => {
      child.once('exit', r)
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    })
  }
}, 60_000)
