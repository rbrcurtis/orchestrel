import { integer, text, real, sqliteTable } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const repos = sqliteTable('repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  path: text('path').notNull(),
  setupCommands: text('setup_commands').default(''),
  isGitRepo: integer('is_git_repo', { mode: 'boolean' }).notNull().default(false),
  defaultBranch: text('default_branch', { enum: ['main', 'dev'] }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const cards = sqliteTable('cards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description').default(''),
  column: text('column', { enum: ['backlog', 'ready', 'in_progress', 'review', 'done'] }).notNull().default('backlog'),
  position: real('position').notNull().default(0),
  priority: text('priority', { enum: ['low', 'medium', 'high', 'urgent'] }).notNull().default('medium'),
  repoId: integer('repo_id').references(() => repos.id, { onDelete: 'set null' }),
  prUrl: text('pr_url'),
  sessionId: text('session_id'),
  worktreePath: text('worktree_path'),
  worktreeBranch: text('worktree_branch'),
  useWorktree: integer('use_worktree', { mode: 'boolean' }).notNull().default(true),
  sourceBranch: text('source_branch', { enum: ['main', 'dev'] }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});
