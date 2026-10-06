/* Local per-user preference storage: one markdown file per user in the
 * orchestrel app's data directory — data/preferences/<email>.md. The email is
 * the id everywhere (the maintainer's listHumanAuthors, the backend auth, and
 * this file name all key off it), which is what lets one user's preferences
 * apply across every project regardless of memory server. fileOps backs the
 * consolidation loop's MemoryOps with that single file. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { MemoryHit, MemoryOps } from '../memory-maintainer/memory-api';
import { canonicalTitle } from './prompt';

export const DEFAULT_PREF_DIR = join('data', 'preferences');

export function prefFilePath(email: string, dir: string): string {
  return join(dir, `${email}.md`);
}

export function fileOps(email: string, dir: string): MemoryOps {
  const path = prefFilePath(email, dir);
  const hit = (): MemoryHit | null => {
    if (!existsSync(path)) return null;
    return { id: email, title: canonicalTitle(email), text: readFileSync(path, 'utf8'), score: 1 };
  };
  const write = (text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
  };
  return {
    search: async () => {
      const h = hit();
      return h ? [h] : [];
    },
    read: async (id) => (id === email ? hit() : null),
    store: async ({ text }) => {
      write(text);
      return { id: email };
    },
    update: async ({ id, text }) => {
      if (id !== email) throw new Error(`unknown preference file id ${id}`);
      write(text);
      return { success: true };
    },
  };
}
