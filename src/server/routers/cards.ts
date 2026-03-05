import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { cards, repos } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { InferInsertModel } from 'drizzle-orm';
import { createWorktree, removeWorktree, runSetupCommands, slugify, worktreeExists } from '../worktree';

const columnEnum = z.enum(['backlog', 'ready', 'in_progress', 'review', 'done']);
const priorityEnum = z.enum(['low', 'medium', 'high', 'urgent']);

export const cardsRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    return ctx.db.select().from(cards).orderBy(cards.position);
  }),

  create: publicProcedure
    .input(z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      column: columnEnum.optional(),
      priority: priorityEnum.optional(),
      repoId: z.number().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const col = input.column ?? 'backlog';
      const existing = await ctx.db.select({ position: cards.position })
        .from(cards)
        .where(eq(cards.column, col))
        .orderBy(cards.position);
      const pos = existing.length > 0
        ? existing[existing.length - 1].position + 1
        : 1;
      const [card] = await ctx.db.insert(cards)
        .values({ ...input, position: pos })
        .returning();
      return card;
    }),

  update: publicProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      priority: priorityEnum.optional(),
      repoId: z.number().nullable().optional(),
      prUrl: z.string().nullable().optional(),
      useWorktree: z.boolean().optional(),
      sourceBranch: z.enum(['main', 'dev']).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const [card] = await ctx.db.update(cards)
        .set({ ...data, updatedAt: new Date().toISOString() })
        .where(eq(cards.id, id))
        .returning();
      return card;
    }),

  move: publicProcedure
    .input(z.object({
      id: z.number(),
      column: columnEnum,
      position: z.number(),
    }))
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db.select().from(cards).where(eq(cards.id, input.id));
      if (!existing) throw new Error(`Card ${input.id} not found`);

      const columnChanged = existing.column !== input.column;

      const updates: Partial<InferInsertModel<typeof cards>> = {
        column: input.column,
        position: input.position,
        updatedAt: new Date().toISOString(),
      };

      // Worktree / working directory setup when moving to in_progress
      if (columnChanged && input.column === 'in_progress' && existing.repoId) {
        try {
          const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, existing.repoId));
          if (repo) {
            if (!existing.useWorktree) {
              // Non-worktree mode: work directly in repo path
              updates.worktreePath = repo.path;
            } else {
              // Worktree mode
              const slug = existing.worktreeBranch || slugify(existing.title);
              const wtPath = existing.worktreePath || `${repo.path}/.worktrees/${slug}`;
              const branch = slug;
              const source = existing.sourceBranch ?? repo.defaultBranch ?? undefined;

              if (!worktreeExists(wtPath)) {
                createWorktree(repo.path, wtPath, branch, source);
                if (repo.setupCommands) {
                  runSetupCommands(wtPath, repo.setupCommands);
                }
              }

              updates.worktreePath = wtPath;
              updates.worktreeBranch = branch;
            }
          }
        } catch (err) {
          console.error(`Failed to set up working directory for card ${existing.id}:`, err);
        }
      }

      // Worktree removal when moving to done (preserve path/branch/session fields)
      if (columnChanged && input.column === 'done' && existing.useWorktree && existing.worktreePath && existing.repoId) {
        try {
          const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, existing.repoId));
          if (repo && worktreeExists(existing.worktreePath)) {
            try {
              removeWorktree(repo.path, existing.worktreePath);
            } catch (err) {
              console.error(`Failed to remove worktree for card ${existing.id}:`, err);
            }
          }
        } catch (err) {
          console.error(`Failed to clean up worktree for card ${existing.id}:`, err);
        }
        // Do NOT null worktreePath, worktreeBranch, or sessionId — needed for resumption
      }

      const [card] = await ctx.db.update(cards)
        .set(updates)
        .where(eq(cards.id, input.id))
        .returning();
      return card;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(cards).where(eq(cards.id, input.id));
    }),
});
