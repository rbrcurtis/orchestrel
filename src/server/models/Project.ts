import {
  Entity, PrimaryGeneratedColumn, Column, BaseEntity,
  EventSubscriber,
  type EntitySubscriberInterface,
  type InsertEvent, type UpdateEvent, type RemoveEvent,
} from 'typeorm'
import { Expose } from 'class-transformer'
import { messageBus } from '../bus'

export const NEON_COLORS = [
  'neon-cyan', 'neon-magenta', 'neon-violet', 'neon-amber',
  'neon-lime', 'neon-coral', 'neon-electric', 'neon-plasma',
] as const

export type NeonColor = typeof NEON_COLORS[number]

@Entity({ name: 'projects' })
export class Project extends BaseEntity {
  @Expose({ groups: ['rest'] })
  @PrimaryGeneratedColumn()
  id!: number

  @Expose({ groups: ['rest'] })
  @Column({ type: 'text' })
  name!: string

  @Column({ type: 'text' })
  path!: string

  @Column({ name: 'setup_commands', type: 'text', default: '' })
  setupCommands!: string

  @Column({ name: 'is_git_repo', type: 'integer', default: 0 })
  isGitRepo!: boolean

  @Column({ name: 'default_branch', type: 'text', nullable: true })
  defaultBranch!: string | null

  @Column({ name: 'default_worktree', type: 'integer', default: 0 })
  defaultWorktree!: boolean

  @Column({ name: 'default_model', type: 'text', default: 'sonnet' })
  defaultModel!: string

  @Column({ name: 'default_thinking_level', type: 'text', default: 'high' })
  defaultThinkingLevel!: string

  @Column({ name: 'provider_id', type: 'text', default: 'anthropic' })
  providerID!: string

  @Column({ type: 'text', nullable: true })
  color!: string | null

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string
}

@EventSubscriber()
export class ProjectSubscriber implements EntitySubscriberInterface<Project> {
  listenTo() { return Project }

  afterInsert(event: InsertEvent<Project>) {
    messageBus.publish(`project:${event.entity.id}:updated`, event.entity)
  }

  afterUpdate(event: UpdateEvent<Project>) {
    messageBus.publish(`project:${(event.entity as Project).id}:updated`, event.entity)
  }

  afterRemove(event: RemoveEvent<Project>) {
    messageBus.publish(`project:${event.entityId}:deleted`, { id: event.entityId })
  }
}
