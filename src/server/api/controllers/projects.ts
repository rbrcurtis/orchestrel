import { Controller, Get, Route } from 'tsoa'
import { instanceToPlain } from 'class-transformer'
import { Project } from '../../models/Project'
import type { ProjectResponse } from '../types'

@Route('api')
export class ProjectsController extends Controller {
  @Get('projects')
  public async listProjects(): Promise<{ projects: ProjectResponse[] }> {
    const projects = await Project.find()
    return {
      projects: projects.map(
        p => instanceToPlain(p, { groups: ['rest'], excludeExtraneousValues: true }) as ProjectResponse,
      ),
    }
  }
}
