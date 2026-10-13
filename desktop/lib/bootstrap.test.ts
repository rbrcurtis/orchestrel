import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'vitest'
import { readBootstrap, writeBootstrap, type BootstrapData } from './bootstrap'

test('writeBootstrap/readBootstrap roundtrip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boot-'))
  const data: BootstrapData = { backendPort: 6194, kppPort: 8193, orcdPort: 4444, authToken: 'sekrit' }
  writeBootstrap(dir, data)
  expect(readBootstrap(dir)).toEqual(data)
})

test('readBootstrap throws with a readable message when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boot-'))
  expect(() => readBootstrap(dir)).toThrow(/bootstrap\.json/)
})
