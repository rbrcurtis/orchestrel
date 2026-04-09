import type { AckResponse, Project } from '../../../shared/ws-protocol';
import type { AppSocket, AppServer } from '../types';
import { projectService } from '../../services/project';
import { getProvidersForClient } from '../../config/providers';

export async function handleProjectCreate(
  data: { name: string; path: string; [key: string]: unknown },
  callback: (res: AckResponse<Project>) => void,
): Promise<void> {
  try {
    const project = await projectService.createProject(data);
    callback({ data: project as unknown as Project });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleProjectUpdate(
  data: { id: number; userIds?: number[]; [key: string]: unknown },
  callback: (res: AckResponse<Project>) => void,
  socket: AppSocket,
  io: AppServer,
): Promise<void> {
  const { id, userIds, ...projectData } = data;
  try {
    const project = await projectService.updateProject(id, projectData);
    callback({ data: project as unknown as Project });

    if (userIds !== undefined) {
      const identity = socket.data.identity;
      if (identity?.role === 'admin') {
        const { userService } = await import('../../services/user');
        await userService.setProjectUsers(id, userIds);

        // Re-sync non-admin clients so their visibility updates
        for (const [, clientSocket] of io.sockets.sockets) {
          const clientIdentity = clientSocket.data.identity;
          if (clientSocket.id === socket.id || clientIdentity?.role === 'admin') continue;

          const visible = await userService.visibleProjectIds(clientIdentity as import('../../services/user').UserIdentity);
          const { cardService } = await import('../../services/card');
          const [syncCards, syncProjects] = await Promise.all([
            cardService.listCards(),
            projectService.listProjects(),
          ]);

          const filteredCards = visible === 'all' ? syncCards
            : syncCards.filter((c) => c.projectId != null && (visible as number[]).includes(c.projectId));
          const filteredProjects = visible === 'all' ? syncProjects
            : syncProjects.filter((p) => (visible as number[]).includes(p.id));

          clientSocket.emit('sync', {
            cards: filteredCards as unknown as import('../../../shared/ws-protocol').Card[],
            projects: filteredProjects as unknown as import('../../../shared/ws-protocol').Project[],
            providers: getProvidersForClient(),
            user: { id: clientIdentity!.id, email: clientIdentity!.email, role: clientIdentity!.role },
          });
        }
      }
    }
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleProjectDelete(
  data: { id: number },
  callback: (res: AckResponse) => void,
): Promise<void> {
  try {
    await projectService.deleteProject(data.id);
    callback({});
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}

export async function handleProjectBrowse(
  data: { path: string },
  callback: (res: AckResponse<unknown>) => void,
): Promise<void> {
  try {
    const dirs = await projectService.browse(data.path);
    callback({ data: dirs });
  } catch {
    callback({ data: [] });
  }
}

export async function handleProjectMkdir(
  data: { path: string },
  callback: (res: AckResponse<{ success: boolean }>) => void,
): Promise<void> {
  try {
    await projectService.mkdir(data.path);
    callback({ data: { success: true } });
  } catch (err) {
    callback({ error: String(err instanceof Error ? err.message : err) });
  }
}
