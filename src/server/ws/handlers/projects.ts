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
  const { userIds, ...projectData } = rest as typeof rest & { userIds?: number[] }
  try {
    const project = await projectService.updateProject(id, projectData)
    connections.send(ws, { type: 'mutation:ok', requestId, data: project })

    if (userIds !== undefined) {
      const identity = connections.getIdentity(ws)
      if (identity?.role === 'admin') {
        const { userService } = await import('../../services/user')
        await userService.setProjectUsers(id, userIds)

        // Re-sync non-admin clients so their visibility updates
        for (const [clientWs, clientIdentity] of connections.entries()) {
          if (clientWs === ws || clientIdentity.role === 'admin') continue

          const visible = await userService.visibleProjectIds(clientIdentity)
          const { cardService } = await import('../../services/card')
          const { getProvidersForClient } = await import('../../config/providers')
          const [syncCards, syncProjects] = await Promise.all([
            cardService.listCards(),
            projectService.listProjects(),
          ])

          const filteredCards = visible === 'all' ? syncCards
            : syncCards.filter((c) => c.projectId != null && (visible as number[]).includes(c.projectId))
          const filteredProjects = visible === 'all' ? syncProjects
            : syncProjects.filter((p) => (visible as number[]).includes(p.id))

          connections.send(clientWs, {
            type: 'sync',
            cards: filteredCards as unknown as import('../../../shared/ws-protocol').Card[],
            projects: filteredProjects as unknown as import('../../../shared/ws-protocol').Project[],
            providers: getProvidersForClient(),
            user: { id: clientIdentity.id, email: clientIdentity.email, role: clientIdentity.role },
          })
        }
      }
    }
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
