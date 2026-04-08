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

@Entity({ name: 'cards' })
export class Card extends BaseEntity {
  @Expose({ groups: ['rest'] })
  @PrimaryGeneratedColumn()
  id!: number;

  @Expose({ groups: ['rest'] })
  @Column({ type: 'text' })
  title!: string;

  @Expose({ groups: ['rest'] })
  @Column({ type: 'text', default: '' })
  description!: string;

  @Column({ type: 'text', default: 'backlog' })
  column!: string;

  @Column({ type: 'real', default: 0 })
  position!: number;

  @Expose({ groups: ['rest'] })
  @Column({ name: 'project_id', type: 'integer', nullable: true })
  projectId!: number | null;

  @Column({ name: 'pr_url', type: 'text', nullable: true })
  prUrl!: string | null;

  @Column({ name: 'session_id', type: 'text', nullable: true })
  sessionId!: string | null;

  @Column({ name: 'worktree_path', type: 'text', nullable: true })
  worktreePath!: string | null;

  @Column({ name: 'worktree_branch', type: 'text', nullable: true })
  worktreeBranch!: string | null;

  @Column({ name: 'use_worktree', type: 'integer', default: 1 })
  useWorktree!: boolean;

  @Column({ name: 'source_branch', type: 'text', nullable: true })
  sourceBranch!: string | null;

  @Column({ type: 'text', default: 'sonnet' })
  model!: string;

  @Column({ type: 'text', default: 'anthropic' })
  provider!: string;

  @Column({ name: 'thinking_level', type: 'text', default: 'high' })
  thinkingLevel!: string;

  @Column({ name: 'prompts_sent', type: 'integer', default: 0 })
  promptsSent!: number;

  @Column({ name: 'turns_completed', type: 'integer', default: 0 })
  turnsCompleted!: number;

  @Column({ name: 'context_tokens', type: 'integer', default: 0 })
  contextTokens!: number;

  @Column({ name: 'context_window', type: 'integer', default: 200000 })
  contextWindow!: number;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;

  @Column({ name: 'updated_at', type: 'text' })
  updatedAt!: string;

  @Column({ name: 'queue_position', type: 'integer', nullable: true, default: null })
  queuePosition!: number | null;

  @Column({ name: 'pending_prompt', type: 'text', nullable: true, default: null })
  pendingPrompt!: string | null;

  @Column({ name: 'pending_files', type: 'text', nullable: true, default: null })
  pendingFiles!: string | null;
}

@EventSubscriber()
export class CardSubscriber implements EntitySubscriberInterface<Card> {
  listenTo() {
    return Card;
  }

  async beforeUpdate(event: UpdateEvent<Card>) {
    const card = event.entity as Card;
    const prev = event.databaseEntity as Card;
    if (prev?.sessionId && card.sessionId !== prev.sessionId) {
      throw new Error(
        `[card:${card.id}] sessionId is immutable once set (was ${prev.sessionId}, attempted ${card.sessionId})`,
      );
    }

    // Card entering running as non-worktree on a git repo: check for conflicts, assign queue position.
    // Non-git-repo projects don't need serialization — no shared working directory to protect.
    if (prev?.column !== 'running' && card.column === 'running' && !card.useWorktree && card.projectId) {
      const { Project } = await import('./Project');
      const proj = await Project.findOneBy({ id: card.projectId });
      if (proj?.isGitRepo) {
        const others = await Card.find({
          where: {
            column: 'running',
            projectId: card.projectId,
            useWorktree: false as unknown as boolean,
          },
        });
        const conflict = others.filter((c) => c.id !== card.id);
        if (conflict.length > 0) {
          const maxPos = conflict.reduce((mx, c) => Math.max(mx, c.queuePosition ?? 0), 0);
          card.queuePosition = maxPos + 1;
          console.log(
            `[card:${card.id}] entering running with ${conflict.length} conflict(s), ` +
              `assigned queuePosition=${card.queuePosition}`,
          );
        } else {
          console.log(`[card:${card.id}] entering running, no conflicts in project ${card.projectId}`);
        }
      }
    }

    // Invariant: queuePosition only exists on running cards.
    if (card.column !== 'running' && card.queuePosition != null) {
      console.log(`[card:${card.id}] leaving running, clearing queuePosition (was ${card.queuePosition})`);
      card.queuePosition = null;
    }
  }

  afterInsert(event: InsertEvent<Card>) {
    messageBus.publish(`card:${event.entity.id}:updated`, event.entity);
    messageBus.publish('board:changed', {
      card: event.entity,
      oldColumn: null,
      newColumn: event.entity.column,
    });
  }

  afterUpdate(event: UpdateEvent<Card>) {
    const card = event.entity as Card;
    const prev = event.databaseEntity as Card;

    messageBus.publish(`card:${card.id}:updated`, card);

    if (prev?.column !== card.column || prev?.queuePosition !== card.queuePosition) {
      messageBus.publish('board:changed', {
        card,
        oldColumn: prev?.column ?? null,
        newColumn: card.column,
      });
    }
    if (
      prev?.promptsSent !== card.promptsSent ||
      prev?.turnsCompleted !== card.turnsCompleted ||
      prev?.sessionId !== card.sessionId
    ) {
      messageBus.publish(`card:${card.id}:status`, card);
    }
  }

  afterRemove(event: RemoveEvent<Card>) {
    messageBus.publish(`card:${event.entityId}:deleted`, { id: event.entityId });
    messageBus.publish('board:changed', {
      card: null,
      oldColumn: null,
      newColumn: null,
      id: event.entityId,
    });
  }
}
