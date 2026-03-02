import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { router, publicProcedure } from '../trpc';

export const sessionsRouter = router({
  loadSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input }) => {
      const claudeProjectsDir = join(homedir(), '.claude', 'projects');

      // Find the session file across all project directories
      let findOutput: string;
      try {
        findOutput = execFileSync(
          'find',
          [claudeProjectsDir, '-maxdepth', '2', '-name', `${input.sessionId}.jsonl`, '-type', 'f'],
          { encoding: 'utf-8' }
        ).trim();
      } catch {
        throw new Error('Session log not found');
      }

      if (!findOutput) throw new Error('Session log not found');

      // If find returns multiple results, take the first
      const filePath = findOutput.split('\n')[0];

      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const messages = lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((m): m is Record<string, unknown> => m !== null);

      // Filter to assistant and user messages only (skip progress, system, file-history-snapshot)
      return messages.filter(
        (m) => m.type === 'assistant' || m.type === 'user'
      );
    }),
});
