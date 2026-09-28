/* Locate a user's canonical preference memory by its deterministic title.
 * The preference project holds every user's canonical memory; the title is the
 * only key, so an exact-title match is the canonical record. */
import { loadMemory, searchMemories } from '../memory-maintainer/memory-api';
import type { MemoryHit, MemoryServer } from '../memory-maintainer/memory-api';

export async function findCanonical(server: MemoryServer, title: string): Promise<MemoryHit | null> {
  const hits = await searchMemories(server, title, 20);
  const hit = hits.find((h) => h.title === title);
  if (!hit) return null;
  // search may return a truncated text; load the full canonical body.
  return (await loadMemory(server, hit.id)) ?? hit;
}
