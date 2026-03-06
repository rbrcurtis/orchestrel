import { z } from 'zod';
import { tracked } from '@trpc/server';
import { router, publicProcedure } from '../trpc';
import { cards } from '../db/schema';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { sessionManager } from '../claude/manager';
import type { SessionStatus } from '../claude/types';

export const claudeRouter = router({
  start: publicProcedure
    .input(z.object({ cardId: z.number(), prompt: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [card] = await ctx.db.select().from(cards).where(eq(cards.id, input.cardId));
      if (!card) throw new Error(`Card ${input.cardId} not found`);
      if (!card.worktreePath) throw new Error(`Card ${input.cardId} has no working directory`);

      const session = sessionManager.create(
        input.cardId,
        card.worktreePath,
        card.sessionId ?? undefined,
      );
      await session.start();

      // Wait for the system init message to capture session_id
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for session init')), 30_000);

        const onMessage = () => {
          if (session.sessionId) {
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

      // Update card with sessionId, reset counters
      await ctx.db.update(cards)
        .set({
          sessionId: session.sessionId,
          promptsSent: 0,
          turnsCompleted: 0,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(cards.id, input.cardId));

      // Persist counters on each turn completion, auto-move on exit
      session.on('message', async (msg: Record<string, unknown>) => {
        if (msg.type === 'result') {
          try {
            await db.update(cards)
              .set({
                promptsSent: session.promptsSent,
                turnsCompleted: session.turnsCompleted,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(cards.id, input.cardId));
          } catch (err) {
            console.error(`Failed to persist counters for card ${input.cardId}:`, err);
          }
        }
      });

      session.on('exit', async () => {
        try {
          await db.update(cards)
            .set({
              column: 'review',
              promptsSent: session.promptsSent,
              turnsCompleted: session.turnsCompleted,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(cards.id, input.cardId));
        } catch (err) {
          console.error(`Failed to auto-move card ${input.cardId} to review:`, err);
        }
      });

      // Send the user's prompt
      session.sendUserMessage(input.prompt);

      return { status: 'started' as const };
    }),

  sendMessage: publicProcedure
    .input(z.object({ cardId: z.number(), message: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const session = sessionManager.get(input.cardId);
      if (!session) throw new Error(`No session for card ${input.cardId}`);
      session.sendUserMessage(input.message);
      await ctx.db.update(cards)
        .set({ promptsSent: session.promptsSent, updatedAt: new Date().toISOString() })
        .where(eq(cards.id, input.cardId));
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

      const wake = () => { resolve?.(); };
      const onMessage = (msg: unknown) => {
        queue.push(msg);
        wake();
      };

      // Register listener BEFORE snapshotting buffer to avoid race
      session.on('message', onMessage);
      session.on('exit', wake);
      const buffered = session.messages.length;

      try {
        // Replay buffered messages
        for (let i = 0; i < buffered; i++) {
          yield tracked(String(counter++), session.messages[i]);
        }

        // Stream live messages
        while (!signal?.aborted && session.status !== 'completed' && session.status !== 'errored') {
          if (queue.length === 0) {
            await new Promise<void>((r) => { resolve = r; });
          }
          while (queue.length > 0) {
            yield tracked(String(counter++), queue.shift());
          }
        }
        // Drain remaining
        while (queue.length > 0) {
          yield tracked(String(counter++), queue.shift());
        }
      } finally {
        session.off('message', onMessage);
        session.off('exit', wake);
      }
    }),

  status: publicProcedure
    .input(z.object({ cardId: z.number() }))
    .query(async ({ ctx, input }) => {
      const session = sessionManager.get(input.cardId);
      if (session) {
        return {
          active: session.status === 'running',
          status: session.status as SessionStatus,
          sessionId: session.sessionId,
          promptsSent: session.promptsSent,
          turnsCompleted: session.turnsCompleted,
        };
      }
      // No active session — read counters from DB
      const [card] = await ctx.db.select({
        promptsSent: cards.promptsSent,
        turnsCompleted: cards.turnsCompleted,
        sessionId: cards.sessionId,
      }).from(cards).where(eq(cards.id, input.cardId));
      return {
        active: false,
        status: 'completed' as SessionStatus,
        sessionId: card?.sessionId ?? null,
        promptsSent: card?.promptsSent ?? 0,
        turnsCompleted: card?.turnsCompleted ?? 0,
      };
    }),

  stop: publicProcedure
    .input(z.object({ cardId: z.number() }))
    .mutation(async ({ input }) => {
      await sessionManager.kill(input.cardId);
      return { status: 'stopped' as const };
    }),
});
