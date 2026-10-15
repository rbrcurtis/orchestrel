// Seeds the desktop app's per-user state tree on first run. Everything lives
// under userData so installs are hermetic: orcd.yaml / orc.yaml /
// bootstrap.json are written once, with ports chosen by binding to port 0 and
// a shared randomUUID authToken cross-referenced between the node daemon, the
// backend registry, and bootstrap.json. bootstrap.json presence is the
// idempotency gate — a second call never rewrites anything.
//
// The DB base tables (projects/cards) are provisioned separately by the
// Electron main process in a short-lived child of the bundled node — the
// backend runs its base-table migrations with synchronize:false, so the
// tables must exist before the backend boots. The schema itself lives in
// out/provision-db.cjs (produced by build-bundles.mjs).
import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import * as net from 'node:net'
import { join } from 'node:path'
import { stringify as dumpYaml } from 'yaml'
import { writeBootstrap, readBootstrap, type BootstrapData } from './bootstrap'
import { writeFileAtomic } from './atomic-write'
import { DESKTOP_LOCAL_USER } from './local-user'

export interface SeedPorts {
  backendPort: number
  orcdPort: number
}

/** Bind `count` servers to port 0 and return the OS-assigned ports. */
export function pickFreePorts(count: number): Promise<number[]> {
  const open = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = addr && typeof addr === 'object' ? addr.port : 0
        srv.close(() => resolve(port))
      })
      srv.on('error', reject)
    })
  return Promise.all(Array.from({ length: count }, open))
}

export interface SeedResult extends SeedPorts {
  seeded: boolean
  authToken: string
}

export async function seedUserData(userDataDir: string): Promise<SeedResult> {
  // bootstrap.json gates idempotency: if it exists, this dir is already seeded.
  try {
    await stat(join(userDataDir, 'bootstrap.json'))
    const existing = readBootstrap(userDataDir)
    return { seeded: false, ...existing }
  } catch {
    // no bootstrap yet — fall through to a full seed
  }

  const [backendPort, orcdPort] = await pickFreePorts(2)
  const authToken = randomUUID()

  await mkdir(join(userDataDir, 'data'), { recursive: true })
  await mkdir(join(userDataDir, 'logs'), { recursive: true })

  const orcdYaml = dumpYaml({
    listen: { host: '127.0.0.1', port: orcdPort },
    authToken,
    name: 'local',
    defaultProvider: 'kiro',
    defaultModel: 'auto',
    defaultThinkingLevel: 'high',
    ringBufferSize: 5000,
    // Desktop owns its single orchestrel.db, so it runs the maintainer jobs
    // (empty projects map: no knowledge memory yet, preference learning on
    // the seeded local user).
    maintainers: true,
    defaultUser: DESKTOP_LOCAL_USER,
    memory: { provider: 'kiro', model: 'auto', projects: {}, preferences: {} },
    // Deliberately empty: the desktop app no longer bundles or runs a provider
    // proxy (KPP), so there is nothing to point at. The 'kiro' names above are
    // placeholders that whatever supplies models next must replace.
    providers: {},
  })
  const orcYaml = dumpYaml({
    servers: [{ name: 'local', host: '127.0.0.1', port: orcdPort, authToken }],
  })
  // The data/ dir is the backend's cwd-relative DB dir, so the supervisor runs
  // the backend with cwd=userData. Every artifact is written before
  // bootstrap.json so the gate only flips after the full seed succeeds, and
  // each write is atomic so a crash can never leave a half-written config —
  // a truncated bootstrap.json would otherwise be unparseable, which reads as
  // "not seeded" and silently re-seeds with new ports and a new token.
  writeFileAtomic(join(userDataDir, 'orcd.yaml'), orcdYaml)
  writeFileAtomic(join(userDataDir, 'orc.yaml'), orcYaml)

  const data: BootstrapData = { backendPort, orcdPort, authToken }
  writeBootstrap(userDataDir, data)

  return { seeded: true, ...data }
}
