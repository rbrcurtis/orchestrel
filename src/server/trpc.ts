import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { db } from './db';

export function createTRPCContext() {
  return { db };
}

export type TRPCContext = ReturnType<typeof createTRPCContext>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  sse: {
    ping: { enabled: true, intervalMs: 15_000 },
    client: { reconnectAfterInactivityMs: 20_000 },
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
