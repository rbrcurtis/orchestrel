import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import type { DbMutator } from '../../db/mutator'
import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'

export async function handleProjectCreate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:create' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
  requestId: string,
): Promise<void> {
  try {
    const input = msg.data
    const isGitRepo = existsSync(join(input.path, '.git'))
    const project = mutator.createProject({ ...input, isGitRepo })
    connections.send(ws, { type: 'mutation:ok', data: { requestId, result: project } })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', data: { requestId, error } })
  }
}

export async function handleProjectUpdate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:update' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
  requestId: string,
): Promise<void> {
  try {
    const { id, ...data } = msg.data
    const updates: Record<string, unknown> = { ...data }
    if (data.path) {
      updates.isGitRepo = existsSync(join(data.path, '.git'))
    }
    const project = mutator.updateProject(id, updates)
    connections.send(ws, { type: 'mutation:ok', data: { requestId, result: project } })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', data: { requestId, error } })
  }
}

export function handleProjectDelete(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:delete' }>,
  connections: ConnectionManager,
  mutator: DbMutator,
  requestId: string,
): void {
  try {
    mutator.deleteProject(msg.data.id)
    connections.send(ws, { type: 'mutation:ok', data: { requestId, result: null } })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    connections.send(ws, { type: 'mutation:error', data: { requestId, error } })
  }
}

export async function handleProjectBrowse(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:browse' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { path, requestId } = msg.data
  try {
    const fsEntries = await readdir(path, { withFileTypes: true })
    const isGitRepo = fsEntries.some(e => e.name === '.git' && e.isDirectory())
    const dirs = fsEntries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: join(path, e.name), isDir: true }))
      .sort((a, b) => a.name.localeCompare(b.name))

    connections.send(ws, {
      type: 'project:browse:result',
      data: { requestId, entries: dirs },
    })

    // NOTE: isGitRepo for the browsed path is not in the protocol browse:result shape.
    // project:create/update re-detect it on save. Suppress unused var.
    void isGitRepo
  } catch {
    connections.send(ws, {
      type: 'project:browse:result',
      data: { requestId, entries: [] },
    })
  }
}
