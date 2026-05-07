import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  BaseEntity,
  EventSubscriber,
  type EntitySubscriberInterface,
  type InsertEvent,
  type UpdateEvent,
  type RemoveEvent,
} from 'typeorm';
import { Expose } from 'class-transformer';
import { messageBus } from '../bus';

/** Well-spaced hex colors from the neon gradient, used for auto-assignment */
export const DEFAULT_COLORS = [
  '#00f0ff',
  '#4d4dff',
  '#bf5af2',
  '#ff00aa',
  '#ff6b6b',
  '#ff5e00',
  '#ffb800',
  '#ccff00',
  '#39ff14',
  '#00e5bf',
  '#00c8ff',
  '#7b61ff',
  '#ff3d8a',
  '#dc143c',
  '#ffd700',
  '#a0f0ff',
] as const;

@Entity({ name: 'projects' })
export class Project extends BaseEntity {
  @Expose({ groups: ['rest'] })
  @PrimaryGeneratedColumn()
  id!: number;

  @Expose({ groups: ['rest'] })
  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  path!: string;

  @Column({ name: 'setup_commands', type: 'text', default: '' })
  setupCommands!: string;

  @Column({ name: 'is_git_repo', type: 'integer', default: 0 })
  isGitRepo!: boolean;

  @Column({ name: 'default_branch', type: 'text', nullable: true })
  defaultBranch!: string | null;

  @Column({ name: 'default_worktree', type: 'integer', default: 0 })
  defaultWorktree!: boolean;

  @Column({ name: 'default_model', type: 'text', default: 'sonnet' })
  defaultModel!: string;

  @Column({ name: 'default_thinking_level', type: 'text', default: 'high' })
  defaultThinkingLevel!: string;

  @Column({ name: 'provider_id', type: 'text' })
  providerID!: string;

  @Column({ type: 'text', default: '#00f0ff' })
  color!: string;

  @Expose({ groups: ['rest'] })
  @Column({ type: 'integer', default: 0, transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number | boolean) => !!v } })
  archived!: boolean;

  @Column({ name: 'memory_base_url', type: 'text', nullable: true })
  memoryBaseUrl!: string | null;

  @Column({ name: 'memory_api_key', type: 'text', nullable: true })
  memoryApiKey!: string | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

@EventSubscriber()
export class ProjectSubscriber implements EntitySubscriberInterface<Project> {
  listenTo() {
    return Project;
  }

  afterInsert(event: InsertEvent<Project>) {
    messageBus.publish(`project:${event.entity.id}:updated`, event.entity);
  }

  afterUpdate(event: UpdateEvent<Project>) {
    messageBus.publish(`project:${(event.entity as Project).id}:updated`, event.entity);
  }

  afterRemove(event: RemoveEvent<Project>) {
    messageBus.publish(`project:${event.entityId}:deleted`, { id: event.entityId });
  }
}
