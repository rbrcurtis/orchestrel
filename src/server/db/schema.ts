import { integer, text, real, sqliteTable } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const NEON_COLORS = [
  'neon-cyan', 'neon-magenta', 'neon-violet', 'neon-amber',
  'neon-lime', 'neon-coral', 'neon-electric', 'neon-plasma',
] as const;

export type NeonColor = typeof NEON_COLORS[number];

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  path: text('path').notNull(),
  setupCommands: text('setup_commands').default(''),
  isGitRepo: integer('is_git_repo', { mode: 'boolean' }).notNull().default(false),
  defaultBranch: text('default_branch', { enum: ['main', 'dev'] }),
  defaultWorktree: integer('default_worktree', { mode: 'boolean' }).notNull().default(false),
  defaultModel: text('default_model', { enum: ['sonnet', 'opus', 'auto'] }).notNull().default('sonnet'),
  defaultThinkingLevel: text('default_thinking_level', { enum: ['off', 'low', 'medium', 'high'] }).notNull().default('high'),
  providerID: text('provider_id').notNull().default('anthropic'),
  color: text('color'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const cards = sqliteTable('cards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description').default(''),
  column: text('column', { enum: ['backlog', 'ready', 'running', 'review', 'done', 'archive'] }).notNull().default('backlog'),
  position: real('position').notNull().default(0),
  projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
  prUrl: text('pr_url'),
  sessionId: text('session_id'),
  worktreePath: text('worktree_path'),
  worktreeBranch: text('worktree_branch'),
  useWorktree: integer('use_worktree', { mode: 'boolean' }).notNull().default(true),
  sourceBranch: text('source_branch', { enum: ['main', 'dev'] }),
  model: text('model', { enum: ['sonnet', 'opus', 'auto'] }).notNull().default('sonnet'),
  thinkingLevel: text('thinking_level', { enum: ['off', 'low', 'medium', 'high'] }).notNull().default('high'),
  promptsSent: integer('prompts_sent').notNull().default(0),
  turnsCompleted: integer('turns_completed').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});
