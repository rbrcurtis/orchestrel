/* Locate a user's canonical preference entry by its deterministic title.
 * The backend is pluggable (MemoryOps); the title is the only key, so an
 * exact-title match is the canonical record. */
import type { MemoryHit, MemoryOps } from '../memory-maintainer/memory-api';

export async function findCanonical(ops: MemoryOps, title: string): Promise<MemoryHit | null> {
  const hits = await ops.search(title, 20);
  const hit = hits.find((h) => h.title === title);
  if (!hit) return null;
  // search may return a truncated text; load the full canonical body.
  return (await ops.read(hit.id)) ?? hit;
}
