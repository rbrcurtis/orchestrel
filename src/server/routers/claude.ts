import { z } from 'zod';
import { tracked } from '@trpc/server';
import { router, publicProcedure } from '../trpc';
import { cards } from '../db/schema';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { sessionManager } from '../claude/manager';
import type { ClaudeSession } from '../claude/protocol';
import type { SessionStatus } from '../claude/types';

export const claudeRouter = router({
  start: publicProcedure
    .input(z.object({ cardId: z.number(), prompt: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [card] = await ctx.db.select().from(cards).where(eq(cards.id, input.cardId));
      if (!card) throw new Error(`Card ${input.cardId} not found`);
      if (!card.worktreePath) throw new Error(`Card ${input.cardId} has no working directory`);

      function waitForInit(s: typeof session) {
        return new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out waiting for session init')), 30_000);
          const onMessage = () => {
            if (s.sessionId) {
              clearTimeout(timeout);
              s.off('message', onMessage);
              resolve();
            }
          };
          s.on('message', onMessage);
          s.on('exit', () => {
            clearTimeout(timeout);
            s.off('message', onMessage);
            reject(new Error('Session exited before init'));
          });
        });
      }

      const isResume = !!card.sessionId;
      const session = sessionManager.create(
        input.cardId,
        card.worktreePath,
        card.sessionId ?? undefined,
      );
      // Register event handlers BEFORE starting
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
        if (session.status !== 'completed' && session.status !== 'errored') return;
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

      session.promptsSent++;
      await session.start(input.prompt);
      await waitForInit(session);

      // For fresh sessions, store the new sessionId and reset counters
      if (!isResume) {
        await ctx.db.update(cards)
          .set({
            sessionId: session.sessionId,
            promptsSent: 1,
            turnsCompleted: 0,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(cards.id, input.cardId));
      }

      return { status: 'started' as const };
    }),

  sendMessage: publicProcedure
    .input(z.object({ cardId: z.number(), message: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      let session = sessionManager.get(input.cardId);

      // If no in-memory session, recreate from DB (e.g. after server restart)
      if (!session) {
        const [card] = await ctx.db.select().from(cards).where(eq(cards.id, input.cardId));
        if (!card?.sessionId || !card.worktreePath) {
          throw new Error(`No session for card ${input.cardId}`);
        }
        session = sessionManager.create(input.cardId, card.worktreePath, card.sessionId);
        session.promptsSent = card.promptsSent ?? 0;
        session.turnsCompleted = card.turnsCompleted ?? 0;

        // Register event handlers (same as start mutation)
        session.on('message', async (msg: Record<string, unknown>) => {
          if (msg.type === 'result') {
            try {
              await db.update(cards)
                .set({
                  promptsSent: session!.promptsSent,
                  turnsCompleted: session!.turnsCompleted,
                  updatedAt: new Date().toISOString(),
                })
                .where(eq(cards.id, input.cardId));
            } catch (err) {
              console.error(`Failed to persist counters for card ${input.cardId}:`, err);
            }
          }
        });

        session.on('exit', async () => {
          if (session!.status !== 'completed' && session!.status !== 'errored') return;
          try {
            await db.update(cards)
              .set({
                column: 'review',
                promptsSent: session!.promptsSent,
                turnsCompleted: session!.turnsCompleted,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(cards.id, input.cardId));
          } catch (err) {
            console.error(`Failed to auto-move card ${input.cardId} to review:`, err);
          }
        });
      }

      await session.sendUserMessage(input.message);
      await ctx.db.update(cards)
        .set({ promptsSent: session.promptsSent, updatedAt: new Date().toISOString() })
        .where(eq(cards.id, input.cardId));
      return { status: 'sent' as const };
    }),

  onMessage: publicProcedure
    .input(z.object({ cardId: z.number() }))
    .subscription(async function* ({ input, signal }) {
      // Wait for session to appear (may be created by concurrent sendMessage mutation)
      let session = sessionManager.get(input.cardId);
      if (!session) {
        session = await new Promise<ClaudeSession | undefined>((resolve) => {
          const timeout = setTimeout(() => { cleanup(); resolve(undefined); }, 15_000);
          const onSession = (cardId: number, s: ClaudeSession) => {
            if (cardId === input.cardId) { cleanup(); resolve(s); }
          };
          const onAbort = () => { cleanup(); resolve(undefined); };
          const cleanup = () => {
            clearTimeout(timeout);
            sessionManager.off('session', onSession);
            signal?.removeEventListener('abort', onAbort);
          };
          sessionManager.on('session', onSession);
          signal?.addEventListener('abort', onAbort);
        });
      }
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
      const replayFrom = session.queryStartIndex;
      const buffered = session.messages.length;

      try {
        // Replay only messages from current query (history loaded separately via JSONL)
        for (let i = replayFrom; i < buffered; i++) {
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
