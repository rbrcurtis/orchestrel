import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { projects, NEON_COLORS } from '../db/schema';
import { eq } from 'drizzle-orm';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';

export const projectsRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    return ctx.db.select().from(projects);
  }),

  create: publicProcedure
    .input(z.object({
      name: z.string().min(1),
      path: z.string().min(1),
      setupCommands: z.string().optional(),
      defaultBranch: z.enum(['main', 'dev']).optional(),
      defaultWorktree: z.boolean().optional(),
      color: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const isGitRepo = existsSync(join(input.path, '.git'));

      // Auto-assign next available neon color if not specified
      let color = input.color;
      if (!color) {
        const existing = await ctx.db.select({ color: projects.color }).from(projects);
        const used = new Set(existing.map(p => p.color));
        color = NEON_COLORS.find(c => !used.has(c)) ?? NEON_COLORS[0];
      }

      const [project] = await ctx.db.insert(projects)
        .values({ ...input, isGitRepo, color })
        .returning();
      return project;
    }),

  update: publicProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      setupCommands: z.string().optional(),
      defaultBranch: z.enum(['main', 'dev']).nullable().optional(),
      defaultWorktree: z.boolean().optional(),
      color: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const updates: typeof data & { isGitRepo?: boolean } = { ...data };
      if (updates.path) {
        updates.isGitRepo = existsSync(join(updates.path, '.git'));
      }
      const [project] = await ctx.db.update(projects)
        .set(updates)
        .where(eq(projects.id, id))
        .returning();
      return project;
    }),

  get: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const [project] = await ctx.db.select().from(projects).where(eq(projects.id, input.id));
      if (!project) throw new Error(`Project ${input.id} not found`);

      const isGitRepo = existsSync(join(project.path, '.git'));
      if (isGitRepo !== project.isGitRepo) {
        await ctx.db.update(projects)
          .set({ isGitRepo })
          .where(eq(projects.id, input.id));
        return { ...project, isGitRepo };
      }
      return project;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(projects).where(eq(projects.id, input.id));
    }),

  // Directory browser for selecting project paths
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
