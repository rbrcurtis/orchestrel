import type { WebSocket } from 'ws'
import type { ClientMessage } from '../../../shared/ws-protocol'
import type { ConnectionManager } from '../connections'
import { projectService } from '../../services/project'

export async function handleProjectCreate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:create' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data } = msg
  try {
    const project = await projectService.createProject(data)
    connections.send(ws, { type: 'mutation:ok', requestId, data: project })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}

export async function handleProjectUpdate(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:update' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data } = msg
  const { id, ...rest } = data
  try {
    const project = await projectService.updateProject(id, rest)
    connections.send(ws, { type: 'mutation:ok', requestId, data: project })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}

export function handleProjectDelete(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:delete' }>,
  connections: ConnectionManager,
): void {
  const { requestId, data } = msg
  projectService.deleteProject(data.id)
    .then(() => connections.send(ws, { type: 'mutation:ok', requestId }))
    .catch(err => connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) }))
}

export async function handleProjectBrowse(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:browse' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data: { path } } = msg
  try {
    const dirs = await projectService.browse(path)
    connections.send(ws, { type: 'project:browse:result', requestId, data: dirs })
  } catch {
    connections.send(ws, { type: 'project:browse:result', requestId, data: [] })
  }
}

export async function handleProjectMkdir(
  ws: WebSocket,
  msg: Extract<ClientMessage, { type: 'project:mkdir' }>,
  connections: ConnectionManager,
): Promise<void> {
  const { requestId, data: { path } } = msg
  try {
    await projectService.mkdir(path)
    connections.send(ws, { type: 'mutation:ok', requestId, data: { success: true } })
  } catch (err) {
    connections.send(ws, { type: 'mutation:error', requestId, error: String(err instanceof Error ? err.message : err) })
  }
}
