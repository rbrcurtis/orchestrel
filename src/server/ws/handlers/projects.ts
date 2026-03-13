import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import { existsSync } from 'fs'
import { readdir, mkdir } from 'fs/promises'
import { join } from 'path'

export async function handleProjectCreate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:create' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId } = msg
  try {
    const input = msg.data
    const isGitRepo = existsSync(join(input.path, '.git'))
    const project = mutator.createProject({ ...input, isGitRepo })
    connections.send(ws, { type: 'mutation:ok', requestId, data: project })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

export async function handleProjectUpdate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:update' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): Promise<void> {
  const { requestId } = msg
  try {
    const { id, ...data } = msg.data
    const updates: Record<string, unknown> = { ...data }
    if (data.path) {
      updates.isGitRepo = existsSync(join(data.path, '.git'))
    }
    const project = mutator.updateProject(id, updates)
    connections.send(ws, { type: 'mutation:ok', requestId, data: project })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

export function handleProjectDelete(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:delete' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
): void {
  const { requestId } = msg
  try {
    mutator.deleteProject(msg.data.id)
    connections.send(ws, { type: 'mutation:ok', requestId })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}

export async function handleProjectBrowse(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:browse' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data: { path } } = msg
  try {
    const fsEntries = await readdir(path, { withFileTypes: true })
    const isGitRepo = fsEntries.some(e => e.name === '.git' && e.isDirectory())
    const dirs = fsEntries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: join(path, e.name), isDir: true }))
      .sort((a, b) => a.name.localeCompare(b.name))

    connections.send(ws, {
      type: 'project:browse:result',
      requestId,
      data: dirs,
    })

    // NOTE: isGitRepo for the browsed path is not in the protocol browse:result shape.
    // project:create/update re-detect it on save. Suppress unused var.
    void isGitRepo
  } catch {
    connections.send(ws, {
      type: 'project:browse:result',
      requestId,
      data: [],
    })
  }
}

export async function handleProjectMkdir(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:mkdir' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data: { path } } = msg
  try {
    await mkdir(path, { recursive: true })
    connections.send(ws, { type: 'mutation:ok', requestId, data: { success: true } })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', requestId, error })
  }
}
