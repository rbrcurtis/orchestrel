// logLine is a void-called fire-and-forget logger, so the contracts that
// matter are the failure modes: a missing/unwritable logs dir must not
// reject (an unhandled rejection is exactly what `void logLine(...)` turns a
// logged error into), and a grown log must roll to main.log.1 instead of
// growing unbounded.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { app } from 'electron'
import { logLine, MAX_LOG_BYTES } from './log'

let tmp: string
const origGetPath = app.getPath

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'orc-log-'))
  app.getPath = () => tmp
})

afterEach(() => {
  app.getPath = origGetPath
  rmSync(tmp, { recursive: true, force: true })
})

test('logLine never rejects and creates the logs dir when missing', async () => {
  // logs/ does not exist yet under the fake userData
  await expect(logLine('boot', 'hello')).resolves.toBeUndefined()
  const body = readFileSync(join(tmp, 'logs', 'main.log'), 'utf8')
  expect(body).toContain('[boot] hello')
})

test('logLine resolves (without rejecting) when the logs dir is unwritable', async () => {
  // Point userData at a FILE: mkdir of <file>/logs must fail, and the log
  // call must swallow that rather than reject into an unhandled rejection.
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'x')
  app.getPath = () => blocker
  await expect(logLine('boot', 'lost')).resolves.toBeUndefined()
})

test('logLine rolls main.log to main.log.1 past MAX_LOG_BYTES and keeps appending', async () => {
  const dir = join(tmp, 'logs')
  mkdirSync(dir, { recursive: true })
  // Seed the log just over the 5 MiB ceiling so the very next line rolls it.
  writeFileSync(join(dir, 'main.log'), 'x'.repeat(MAX_LOG_BYTES + 1))
  await logLine('boot', 'after-rotation')

  const rotated = readFileSync(join(dir, 'main.log.1'), 'utf8')
  expect(rotated).toHaveLength(MAX_LOG_BYTES + 1)
  const fresh = readFileSync(join(dir, 'main.log'), 'utf8')
  expect(fresh).toContain('[boot] after-rotation')
  expect(statSync(join(dir, 'main.log')).size).toBeLessThan(MAX_LOG_BYTES)
  expect(existsSync(join(dir, 'main.log'))).toBe(true)
})
