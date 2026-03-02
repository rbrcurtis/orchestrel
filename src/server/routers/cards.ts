import { z } from 'zod';
import { router, publicProcedure } from '../trpc';
import { cards } from '../db/schema';
import { eq } from 'drizzle-orm';

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
      const [card] = await ctx.db.update(cards)
        .set({
          column: input.column,
          position: input.position,
          updatedAt: new Date().toISOString(),
        })
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
