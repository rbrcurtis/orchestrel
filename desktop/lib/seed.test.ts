import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { pickFreePorts, seedUserData } from './seed'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'seed-'))
}

test('seeds all three artifacts and the two directories on first run', async () => {
  const dir = await tmp()
  try {
    const res = await seedUserData(dir)
    expect(res.seeded).toBe(true)
    for (const p of [res.backendPort, res.orcdPort]) {
      expect(Number.isInteger(p)).toBe(true)
      expect(p).toBeGreaterThan(0)
    }
    // token is random and present (cross-checked against orcd.yaml above)
    expect(res.authToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    const orcd = parseYaml(readFileSync(join(dir, 'orcd.yaml'), 'utf8')) as {
      listen: { host: string; port: number }
      authToken: string
      name: string
      defaultProvider: string
      defaultModel: string
      defaultThinkingLevel: string
      ringBufferSize: number
      maintainers: boolean
      defaultUser: string
      memory: { provider: string; model: string; projects: Record<string, unknown>; preferences: Record<string, unknown> }
      providers: Record<string, { label: string; baseUrl: string; apiKey: string; models: Record<string, { modelID: string; label: string; contextWindow: number }> }>
    }
    const orc = parseYaml(readFileSync(join(dir, 'orc.yaml'), 'utf8')) as {
      servers: Array<{ name: string; host: string; port: number; authToken: string }>
    }
    const boot = JSON.parse(readFileSync(join(dir, 'bootstrap.json'), 'utf8')) as {
      backendPort: number
      orcdPort: number
      authToken: string
    }

    // token + port consistency across all three artifacts
    expect(orcd.authToken).toBe(orc.servers[0].authToken)
    expect(orcd.authToken).toBe(boot.authToken)
    expect(orcd.listen.port).toBe(boot.orcdPort)
    expect(orc.servers[0].port).toBe(boot.orcdPort)

    // orcd.yaml content
    expect(orcd.listen.host).toBe('127.0.0.1')
    expect(orcd.name).toBe('local')
    expect(orcd.defaultProvider).toBe('kiro')
    expect(orcd.defaultModel).toBe('auto')
    // The product default is high — without this key orcd falls back to its
    // compiled-in default, silently desyncing desktop cards from the web app.
    expect(orcd.defaultThinkingLevel).toBe('high')
    expect(orcd.ringBufferSize).toBe(5000)
    // Desktop owns its only orchestrel.db → it runs the maintainer jobs, with
    // the seeded local user as attribution target (preference learning).
    expect(orcd.maintainers).toBe(true)
    expect(orcd.defaultUser).toBe('local@orchestrel.local')
    expect(orcd.memory.provider).toBe('kiro')
    expect(orcd.memory.model).toBe('auto')
    expect(orcd.memory.preferences).toEqual({})
    // No provider is bundled or spawned any more: the seeded map is empty, so
    // nothing reads a local proxy port that does not exist.
    expect(orcd.providers).toEqual({})

    // orc.yaml content
    expect(orc.servers[0]).toMatchObject({ name: 'local', host: '127.0.0.1' })

    // directories
    await stat(join(dir, 'data'))
    await stat(join(dir, 'logs'))

    // every artifact went through the atomic tmp+rename write, so no staging
    // file is left behind for a later boot (or a human) to trip over
    const leftovers = (await readdir(dir, { recursive: true })).filter((f) => String(f).endsWith('.tmp'))
    expect(leftovers).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('second call is a no-op returning the stored bootstrap', async () => {
  const dir = await tmp()
  try {
    const first = await seedUserData(dir)
    expect(first.seeded).toBe(true)
    const mtime = await stat(join(dir, 'orcd.yaml'))
    const second = await seedUserData(dir)
    expect(second.seeded).toBe(false)
    expect(second.backendPort).toBe(first.backendPort)
    expect(second.orcdPort).toBe(first.orcdPort)
    expect(second.orcdPort).toBe(first.orcdPort)
    expect(second.authToken).toBe(first.authToken)
    const mtime2 = await stat(join(dir, 'orcd.yaml'))
    expect(mtime2.mtimeMs).toBe(mtime.mtimeMs)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('picked ports are distinct and not zero', async () => {
  const ports = await pickFreePorts(3)
  expect(ports).toHaveLength(3)
  for (const p of ports) {
    expect(Number.isInteger(p)).toBe(true)
    expect(p).toBeGreaterThan(0)
  }
  expect(new Set(ports).size).toBe(3)
})
