import { z } from 'zod';
import { tracked } from '@trpc/server';
import { router, publicProcedure } from '../trpc';
import { cards } from '../db/schema';
import { eq } from 'drizzle-orm';
import { sessionManager } from '../claude/manager';
import type { SessionStatus } from '../claude/types';

export const claudeRouter = router({
  start: publicProcedure
    .input(z.object({ cardId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const [card] = await ctx.db.select().from(cards).where(eq(cards.id, input.cardId));
      if (!card) throw new Error(`Card ${input.cardId} not found`);
      if (!card.worktreePath) throw new Error(`Card ${input.cardId} has no working directory`);

      const isResume = !!card.sessionId;
      const session = sessionManager.create(
        input.cardId,
        card.worktreePath,
        card.sessionId ?? undefined,
      );
      await session.start();

      // Wait for the system init message to capture session_id
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for session init')), 30_000);

        const onMessage = (msg: Record<string, unknown>) => {
          if (msg.type === 'system' && msg.subtype === 'init' && session.sessionId) {
            clearTimeout(timeout);
            session.off('message', onMessage);
            resolve();
          }
        };
        session.on('message', onMessage);

        session.on('exit', () => {
          clearTimeout(timeout);
          session.off('message', onMessage);
          reject(new Error('Session exited before init'));
        });
      });

      // Update card with sessionId (may be new or same)
      await ctx.db.update(cards)
        .set({ sessionId: session.sessionId, updatedAt: new Date().toISOString() })
        .where(eq(cards.id, input.cardId));

      // Only send initial prompt for new sessions
      if (!isResume) {
        if (!card.description?.trim()) throw new Error(`Card ${input.cardId} has no description`);
        session.sendUserMessage(card.description.trim());
      }

      return { status: 'started' as const };
    }),

  sendMessage: publicProcedure
    .input(z.object({ cardId: z.number(), message: z.string().min(1) }))
    .mutation(({ input }) => {
      const session = sessionManager.get(input.cardId);
      if (!session) throw new Error(`No session for card ${input.cardId}`);
      session.sendUserMessage(input.message);
      return { status: 'sent' as const };
    }),

  onMessage: publicProcedure
    .input(z.object({ cardId: z.number() }))
    .subscription(async function* ({ input, signal }) {
      const session = sessionManager.get(input.cardId);
      if (!session) return;

      let counter = 0;
      const queue: unknown[] = [];
      let resolve: (() => void) | null = null;

      const onMessage = (msg: unknown) => {
        queue.push(msg);
        resolve?.();
      };

      session.on('message', onMessage);

      try {
        while (!signal?.aborted && session.status !== 'completed' && session.status !== 'errored') {
          if (queue.length === 0) {
            await new Promise<void>((r) => { resolve = r; });
          }
          while (queue.length > 0) {
            yield tracked(String(counter++), queue.shift());
          }
        }
        // Yield any remaining messages
        while (queue.length > 0) {
          yield tracked(String(counter++), queue.shift());
        }
      } finally {
        session.off('message', onMessage);
      }
    }),

  status: publicProcedure
    .input(z.object({ cardId: z.number() }))
    .query(({ input }) => {
      const session = sessionManager.get(input.cardId);
      return {
        active: session?.status === 'running',
        status: (session?.status ?? 'completed') as SessionStatus,
        sessionId: session?.sessionId ?? null,
      };
    }),

  stop: publicProcedure
    .input(z.object({ cardId: z.number() }))
    .mutation(({ input }) => {
      sessionManager.kill(input.cardId);
      return { status: 'stopped' as const };
    }),
});
