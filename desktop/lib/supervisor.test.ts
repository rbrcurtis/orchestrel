import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdirSync, appendFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import * as http from 'node:http'
import { afterEach, beforeEach, test, expect, vi } from 'vitest'
import { MAX_RESPAWNS, Supervisor, type ServiceDef } from './supervisor'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

// The spawn option in SupervisorOptions is the sanctioned production seam
// (electron app dir vs test fixtures), which also lets tests drive crashes.
type FakeProc = EventEmitter & {
  defId: string
  stdout: PassThrough
  stderr: PassThrough
  killCalls: string[]
  kill(signal?: NodeJS.Signals | number | null): boolean
}

function makeFakeProc(id: string): FakeProc {
  const e = new EventEmitter() as FakeProc
  e.defId = id
  e.stdout = new PassThrough()
  e.stderr = new PassThrough()
  e.killCalls = []
  e.kill = (signal) => {
    e.killCalls.push(String(signal))
    e.emit('exit', null, signal)
    return true
  }
  return e
}

// Fakes are EventEmitters, not real child processes; this single cast at the
// spawn seam is the test boundary the brief sanctions.
function fake(p: FakeProc): ChildProcessWithoutNullStreams {
  return p as unknown as ChildProcessWithoutNullStreams
}

// distinct cwd per def so spawn can identify which def it is (def.id isn't in
// the spawn signature; cwd is, and it's stable per-service in real ServiceDefs)
function defs(base: string, ids: ServiceDef['id'][]): ServiceDef[] {
  return ids.map((id, i) => ({
    id,
    command: 'noop',
    args: [],
    env: {},
    cwd: join(base, `${id} ${i}`)
  }))
}

function idOf(d: ServiceDef[], o: { env: Record<string, string>; cwd: string }): string {
  return d.find((x) => x.cwd === o.cwd)!.id
}

function healthServer(initial: boolean): Promise<{
  url: string
  setReady: (r: boolean) => void
  close: () => Promise<void>
}> {
  let ready = initial
  const server = http.createServer((_req, res) => {
    res.writeHead(ready ? 200 : 503)
    res.end(ready ? 'ok' : 'nope')
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}/`,
        setReady: (r) => {
          ready = r
        },
        close: () => new Promise((res) => server.close(() => res()))
      })
    })
  )
}

let base: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'sup-'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('starts services in the order given and gates on the health url', async () => {
  const health = await healthServer(false)
  const d = defs(base, ['kpp', 'orcd', 'backend'])
  const order: string[] = []
  const sup = new Supervisor({
    logDir: join(base, 'logs'),
    healthUrl: health.url,
    spawn: (_c, _a, o) => {
      const id = idOf(d, o)
      order.push(id)
      const p = makeFakeProc(id)
      if (id === 'backend') p.stdout.resume()
      return fake(p)
    }
  })
  const p = sup.start(d)
  const pending = new Promise<number>((r) => setTimeout(() => r(1), 400))
  const raced = await Promise.race([p.then(() => 0), pending])
  expect(raced).toBe(1) // start() must remain gated on healthUrl answering 200
  health.setReady(true)
  await p
  expect(order).toEqual(['kpp', 'orcd', 'backend'])
  await health.close()
  await sup.stop()
})

test('respawns a crashed service within the rate window', async () => {
  const health = await healthServer(true)
  const d = defs(base, ['kpp', 'orcd', 'backend'])
  const spawned: string[] = []
  const current = new Map<string, FakeProc>()
  const sup = new Supervisor({
    logDir: join(base, 'logs'),
    healthUrl: health.url,
    spawn: (_c, _a, o) => {
      const id = idOf(d, o)
      const p = makeFakeProc(id)
      spawned.push(id)
      current.set(id, p)
      return fake(p)
    }
  })
  await sup.start(d)
  const crash = vi.fn()
  sup.on('crash', crash)
  current.get('orcd')!.emit('exit', 1, null)
  await vi.waitFor(() => expect(spawned.filter((i) => i === 'orcd')).toHaveLength(2))
  expect(spawned.filter((i) => i !== 'orcd')).toEqual(['kpp', 'backend'])
  expect(crash).not.toHaveBeenCalled()
  await health.close()
  await sup.stop()
})

test('gives up after MAX_RESPAWNS rapid exits and emits crash with log tail', async () => {
  const health = await healthServer(true)
  const logDir = join(base, 'logs')
  const d = defs(base, ['backend'])
  const captured: FakeProc[] = []
  const sup = new Supervisor({
    logDir,
    healthUrl: health.url,
    spawn: () => {
      // write the log tail synchronously to the real log file so the crash
      // callback's snapshot is deterministic regardless of append ordering
      mkdirSync(logDir, { recursive: true })
      for (let i = 0; i < 150; i++) appendFileSync(join(logDir, 'backend.log'), `boom line ${i}\n`)
      const p = makeFakeProc('backend')
      captured.push(p)
      return fake(p)
    }
  })
  const crash = vi.fn()
  sup.on('crash', crash)
  await sup.start(d)
  // respawn is synchronous in the exit handler, so each kill resolves before
  // the next line runs and captured.length stays honest
  for (let i = 0; i < 6; i++) {
    if (captured.length <= i) break
    captured[i].emit('exit', 1, null)
  }
  expect(captured.length).toBe(1 + MAX_RESPAWNS)
  expect(crash).toHaveBeenCalledTimes(1)
  const [svc, logTail, gaveUp] = crash.mock.calls[0]!
  expect(svc.id).toBe('backend')
  expect(gaveUp).toBe(true)
  expect(logTail).toContain('boom line 149') // tail = last 100 lines
  await health.close()
  await sup.stop()
})

test('restart(id) resets the rate window and respawns once', async () => {
  const health = await healthServer(true)
  const d = defs(base, ['backend'])
  const captured: FakeProc[] = []
  const sup = new Supervisor({
    logDir: join(base, 'logs'),
    healthUrl: health.url,
    spawn: () => {
      const p = makeFakeProc('backend')
      captured.push(p)
      return fake(p)
    }
  })
  const crash = vi.fn()
  sup.on('crash', crash)
  await sup.start(d)
  // give up: initial spawn + MAX_RESPAWNS respawns, then the 6th exit reports
  for (let i = 0; i <= MAX_RESPAWNS; i++) captured[i]!.emit('exit', 1, null)
  expect(captured).toHaveLength(1 + MAX_RESPAWNS)
  expect(crash).toHaveBeenCalledTimes(1)
  // restart resets the window and spawns exactly once
  await sup.restart('backend')
  expect(captured).toHaveLength(2 + MAX_RESPAWNS)
  // the rate window is reset: one fast exit now respawns instead of crashing
  captured[captured.length - 1]!.emit('exit', 1, null)
  await vi.waitFor(() => expect(captured).toHaveLength(3 + MAX_RESPAWNS))
  expect(crash).toHaveBeenCalledTimes(1) // still just the original give-up
  await health.close()
  await sup.stop()
})

test('stop() kills all children and drains stdio', async () => {
  const health = await healthServer(true)
  const d = defs(base, ['kpp', 'orcd', 'backend'])
  const procs: FakeProc[] = []
  const sup = new Supervisor({
    logDir: join(base, 'logs'),
    healthUrl: health.url,
    spawn: (_c, _a, o) => {
      const p = makeFakeProc(idOf(d, o))
      procs.push(p)
      return fake(p)
    }
  })
  await sup.start(d)
  expect(procs).toHaveLength(3)
  await sup.stop()
  for (const p of procs) {
    expect(p.killCalls).toEqual(['SIGTERM']) // each killed exactly once
  }
  await health.close()
})

test('spawns with array args — paths with spaces are not word-split', async () => {
  const health = await healthServer(true)
  const cwd = join(base, 'my workspace')
  await mkdir(cwd, { recursive: true })
  const seen: { args: string[]; cwd: string }[] = []
  const sup = new Supervisor({
    logDir: join(base, 'logs'),
    healthUrl: health.url,
    spawn: (_c, a, o) => {
      seen.push({ args: a, cwd: o.cwd })
      return fake(makeFakeProc('backend'))
    }
  })
  const d: ServiceDef[] = [
    {
      id: 'backend',
      command: 'node',
      args: [join(cwd, 'server with spaces.js'), '--port', '6194'],
      env: {},
      cwd
    }
  ]
  await sup.start(d)
  expect(seen[0]!.cwd).toBe(cwd)
  expect(seen[0]!.args).toEqual([join(cwd, 'server with spaces.js'), '--port', '6194'])
  await health.close()
  await sup.stop()
})
