import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic-write'

export interface BootstrapData {
  backendPort: number
  kppPort: number
  orcdPort: number
  authToken: string
}

const FILE = 'bootstrap.json'

export function writeBootstrap(dir: string, data: BootstrapData): void {
  mkdirSync(dir, { recursive: true })
  writeFileAtomic(join(dir, FILE), JSON.stringify(data, null, 2))
}

export function readBootstrap(dir: string): BootstrapData {
  const raw = readFileSync(join(dir, FILE), 'utf8')
  return JSON.parse(raw) as BootstrapData
}
