import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { repos } from '../db/schema';
import { eq } from 'drizzle-orm';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';

export const reposRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    return ctx.db.select().from(repos);
  }),

  create: publicProcedure
    .input(z.object({
      name: z.string().min(1),
      path: z.string().min(1),
      setupCommands: z.string().optional(),
      defaultBranch: z.enum(['main', 'dev']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const isGitRepo = existsSync(join(input.path, '.git'));
      const [repo] = await ctx.db.insert(repos)
        .values({ ...input, isGitRepo })
        .returning();
      return repo;
    }),

  update: publicProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      setupCommands: z.string().optional(),
      defaultBranch: z.enum(['main', 'dev']).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const updates: typeof data & { isGitRepo?: boolean } = { ...data };
      if (updates.path) {
        updates.isGitRepo = existsSync(join(updates.path, '.git'));
      }
      const [repo] = await ctx.db.update(repos)
        .set(updates)
        .where(eq(repos.id, id))
        .returning();
      return repo;
    }),

  get: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, input.id));
      if (!repo) throw new Error(`Repo ${input.id} not found`);

      const isGitRepo = existsSync(join(repo.path, '.git'));
      if (isGitRepo !== repo.isGitRepo) {
        await ctx.db.update(repos)
          .set({ isGitRepo })
          .where(eq(repos.id, input.id));
        return { ...repo, isGitRepo };
      }
      return repo;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(repos).where(eq(repos.id, input.id));
    }),

  // Directory browser for selecting repo paths
  browse: publicProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ input }) => {
      try {
        const entries = await readdir(input.path, { withFileTypes: true });
        const dirs = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => ({
            name: e.name,
            path: join(input.path, e.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const isGitRepo = entries.some(e => e.name === '.git' && e.isDirectory());
        return { dirs, isGitRepo, currentPath: input.path };
      } catch {
        return { dirs: [], isGitRepo: false, currentPath: input.path, error: 'Cannot read directory' };
      }
    }),
});
