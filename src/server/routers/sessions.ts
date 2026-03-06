import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { router, publicProcedure } from '../trpc';

const SESSIONS_DIR = join(process.cwd(), 'data', 'sessions');

function parseSessionFile(content: string): Record<string, unknown>[] {
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
    .filter((m): m is Record<string, unknown> => m !== null);
}

export const sessionsRouter = router({
  loadSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      const localPath = join(SESSIONS_DIR, `${input.sessionId}.jsonl`);
      if (existsSync(localPath)) {
        const content = await readFile(localPath, 'utf-8');
        const messages = parseSessionFile(content);
        return messages.filter(
          (m) => m.type === 'assistant' || m.type === 'user' || m.type === 'result' || m.type === 'system'
        );
      }

      return [];
    }),
});
